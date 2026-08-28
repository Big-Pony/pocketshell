// A3 (slice-1, plaintext): a Bun WebSocket server wiring the wire protocol to
// TerminalService (A2) + ReplayService (A4). Noise handshake + pairing land in
// a later slice; the message shapes here are the frozen contract from A3 §3.
// S4a: wrapped in SecureChannel handshake — plaintext message loop unchanged.
// S4b: in-channel pairing — pending state, pair verify, registry∪env authorize.
import type { ServerWebSocket } from "bun";
import { loadConfig, type AgentConfig, resolveTlsMaterial, buildPairingString, resolveAdvertise } from "./config";
import { TerminalService } from "./terminal";
import { ShellService } from "./shell-service";
import { ReplayService, tailWithinBudget, GAP_BACKFILL_BUDGET_BYTES } from "./replay";
import { OutputBatcher } from "./output-batcher";
import { sweepTmp } from "./fs-service";
import { RPC_FIT_SAFE_BYTES, RPC_CHUNK_PAYLOAD_BYTES, chunkRpcPayload } from "./rpc-fit";
import { compressRpcPayload, zipFitsOneFrame } from "./rpc-compress";
import { packBinFrame, BIN_FRAME_PREFIX_BYTES, BIN_FRAME_MAGIC, unpackBinFrame } from "./binframe";
import { decodeClient, encode, type ServerMsg, type DeviceInfo, type SessionMeta } from "./protocol";
import { sessionListsEqual } from "./sessions-diff";
import { isSaneSize } from "./sane-size";
import { toB64, fromB64 } from "./bytes";
import { createResponderChannel, type SecureChannel } from "./secure-channel";
import { resolveStatic, contentEtag, isNotModified } from "./static-serve";
import { brandManifest, brandHtml } from "./instance-brand";
import { ASSETS } from "./embedded-manifest";
import { createPairing, readPendingPairing, clearPendingPairing, shouldAdoptDiskPairing } from "./pairing";
import { isLocalAddr } from "./net-addr";
import { watchRegistryFile, readStamp } from "./registry-watch";
import { PreviewTokens } from "./preview-service";
import { buildPreviewResponse } from "./server-preview";
import { buildThemeCssResponse, importTheme } from "./server-theme";
import { AGENT_VERSION } from "./version";
import { checkLatest } from "./update-check";
import { readCache, writeCache, type CachedCheck } from "./update-cache";
import { downloadAndVerify, type Phase } from "./update-apply";
import { signBinary } from "./codesign-provision";
import { restartSelf } from "./self-restart";
import { NotificationService, type DevicePresence } from "./notify-service";
import { wireClaude, unwireClaude, wireCodex, unwireCodex, wireOpencode, unwireOpencode, wireKimi, unwireKimi, type WireResult } from "./notify-wire";
import { ContextStore } from "./context-store";
import { AI_TOOLS, type AiTool } from "./ai-context";
import { dispatchRpc } from "./rpc-router";
import { formatDiagReport } from "./diag-report";
import { runCli } from "./cli-entry";

// 入参可选：调用点的 `tool` 来自解析后的 JSON body（`tool?: string`）。收窄成
// 必填 string 会逼调用点加非空断言，而这里本来就该把 undefined 判成「不是 AI
// 工具」——includes(undefined) 返回 false，运行时语义不变。
function isAiTool(t: string | undefined): t is AiTool { return (AI_TOOLS as readonly string[]).includes(t as string); }
import { ensureVapid, realPushSender } from "./web-push";
import { renameSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { $ } from "bun";

// Pure precondition gate for update.apply — kept outside startServer so it is
// unit-testable without spinning up a server or touching the real download/
// sign/swap/restart pipeline (that part is verified manually on real hardware,
// see .superpowers/sdd/task-10-report.md).
export function applyGate(
  repo: string | null,
  cache: CachedCheck | null,
  applying: boolean,
  official = true,
): { started: false; reason: string } | { started: true; latest: string } {
  if (!repo) return { started: false, reason: "disabled" };
  // RCE-⑥ / VULN-002. `update.apply` fetches a binary and renames it over the
  // running executable; its only integrity check is a SHA256SUMS.txt from the
  // same release, so whoever controls the repo controls both sides of the
  // comparison. Auto-apply is therefore restricted to the built-in repo.
  //
  // Checking still works against a fork (`update.check` never calls this gate),
  // so the version banner and "update available" UI keep functioning — you just
  // have to install a fork's build deliberately instead of having the agent
  // swap its own binary on the say-so of an env var.
  if (!official) return { started: false, reason: "unofficial_repo" };
  if (applying) return { started: false, reason: "in_progress" };
  if (!cache?.canApply || !cache.latest) return { started: false, reason: cache?.reason ?? "no_release_info" };
  return { started: true, latest: cache.latest };
}

interface Deps {
  port?: number;
  config?: AgentConfig;
  terminal?: TerminalService;
  shell?: ShellService;
  replay?: ReplayService;
  channelFactory?: () => SecureChannel;
  pairTimeoutMs?: number;
  assets?: Record<string, string>;
  /**
   * 覆盖诊断埋点开关，仅供测试。生产走 config（env `POCKETSHELL_DIAG` 或
   * agent.json 的 `diag`，默认关闭）。测试若要断言埋点内容就必须显式打开，
   * 这本身也是一道保险：**默认关闭若被改坏，这些测试会立刻红**。
   */
  diag?: boolean;
}

// agent 在每个 sessions 帧里声明的可选能力位。见 protocol.ts 的 ServerMsg.sessions
// 注释：客户端见到 "bin" 才会对 fs.uploadChunk/fs.write 发二进制上行帧，agent 侧
// 这两个方法已经改成非二进制帧必抛（rpc-router.ts 的 blobOf），所以这个字段
// **不是可选装饰，是让上传/保存不失败的必要前提**。两个 sessions 发送点
// （广播 + listSessions 回复）共用同一个常量，防止两处各自维护漂移出偏差。
const AGENT_FEATURES: string[] = ["bin"];

export function startServer(deps: Deps = {}) {
  const config = deps.config ?? loadConfig();
  // 诊断埋点默认关闭时，客户端**根本不该开始采样**——否则每个活跃会话每 15s
  // 仍要跑三条 rpc，只是服务端把结果丢掉，白烧手机电量和一条 WS。所以把它做成
  // 能力位：客户端见到 "diag" 才采样（见 app 的 Terminal.svelte）。
  // 老客户端不认这个位、照常采样，服务端静默丢弃，行为退化但不出错。
  const diagOn = deps.diag ?? config.diag;
  const features = diagOn ? [...AGENT_FEATURES, "diag"] : AGENT_FEATURES;
  // rpc handler 通过 ctx.config.diag 判断，所以覆盖必须落到传下去的那份 config
  // 上，否则 deps.diag 只影响 server.ts 自己的三处埋点，rpc 侧的两处仍走原值。
  const rpcConfig: AgentConfig = deps.diag === undefined ? config : { ...config, diag: diagOn };
  const terminal = deps.terminal ?? new TerminalService();
  const replay = deps.replay ?? new ReplayService(config.replayBufferBytes);
  const contextStore = new ContextStore();

  const envKeys = new Set(config.authorizedKeys);
  // Tracks when the currently-held pairing code was minted, so a newer
  // disk-minted code (from `pocketshell-agent pair`) can preempt it. The boot
  // code is minted inside loadConfig(), i.e. just before startServer() runs.
  let pairingMintedAt = Date.now();
  const adoptDiskPairing = () => {
    // req 7-1: a CLI-minted pending pairing (pairing.pending.json) lets an
    // already-running agent accept a code it didn't mint itself. Adopt when our
    // in-memory pairing isn't live, OR when the disk code was minted later than
    // ours — without the latter, `pair` is silently a no-op for the first 300s
    // after boot and the operator sees a misleading bad_code (field bug,
    // 2026-07-30). Brute force is still bounded by rate-limit.ts at handshake.
    const rec = readPendingPairing(config.keyDir, Date.now());
    if (!rec) return;
    if (!shouldAdoptDiskPairing({
      memoryLive: config.pairing?.isLive() ?? false,
      memoryMintedAt: pairingMintedAt,
      diskMintedAt: rec.mintedAt ?? 0,
    })) return;
    config.pairing = createPairing({
      code: rec.code,
      ttlMs: Math.max(0, rec.expiresAt - Date.now()),
      maxAttempts: rec.maxAttempts,
      now: () => Date.now(),
    });
    config.pairingMode = true;
    pairingMintedAt = rec.mintedAt ?? Date.now();
  };
  const authorize = (pub: string): "authorized" | "pending" | "reject" => {
    if (config.registry.has(pub) || envKeys.has(pub)) return "authorized";
    // Admit an unregistered peer to the pending window only while the pairing
    // code is still live (not consumed/expired). Once spent, unregistered peers
    // are rejected at the handshake rather than kept admissible for the whole
    // process lifetime.
    adoptDiskPairing();
    if (config.pairingMode && config.pairing?.isLive()) return "pending";
    return "reject";
  };

  const channelFactory =
    deps.channelFactory ??
    (() => createResponderChannel({ identity: config.identity, authorize }));

  const pairTimeoutMs = deps.pairTimeoutMs ?? 10_000;
  const assets = deps.assets ?? ASSETS;
  const assetKeys = new Set(Object.keys(assets));
  // Content-addressed validators: hash each served file once (lazily), then
  // reuse for If-None-Match checks. The hashed body is the served variant
  // itself, so .br/.gz variants get their own ETags automatically.
  // 需要按实例名改写的两个文件。其余静态资源走原路径。
  const BRANDED_ASSETS = new Set(["/manifest.webmanifest", "/index.html"]);
  const etagCache = new Map<string, string>();
  const etagFor = async (assetKey: string): Promise<string> => {
    let etag = etagCache.get(assetKey);
    if (!etag) {
      etag = contentEtag(await Bun.file(assets[assetKey]).arrayBuffer());
      etagCache.set(assetKey, etag);
    }
    return etag;
  };

  interface Conn {
    ws: ServerWebSocket<unknown>;
    channel: SecureChannel;
    ready: boolean;
    pending: boolean;
    remoteStatic: string | null;
    ip: string;
    pairTimer?: ReturnType<typeof setTimeout>;
    // A3: sessions this conn receives output/exit for. attach adds, detach
    // removes; old clients never detach, so their set only grows (≈ old
    // broadcast behaviour, minus sessions they never attached to).
    subscriptions: Set<string>;
    // A6: sessions whose output frames were dropped for this conn while its
    // socket was backed up; each earns a resync once the buffer drains.
    needsResyncSessions: Set<string>;
  }
  const conns = new Map<ServerWebSocket<unknown>, Conn>();
  // Token-scoped HTTP preview access, minted over the authed WS (below) and
  // consumed by the /preview route. Tokens are bound to the device pubkey and
  // reclaimed when that device has no live connections left.
  const previewTokens = new PreviewTokens();

  // 诊断埋点的唯一出口。总开关默认关闭（见 diag-report.ts 的 diagEnabled）——
  // 走一个函数而不是在每个 console.log 前加 if，是为了让「加了新埋点却忘了挂
  // 开关」在代码里没有可乘之机：所有 kind 都必须经过这里。
  const diagLog = (payload: unknown) => {
    if (!diagOn) return;
    console.log(formatDiagReport(payload));
  };
  // 通道看门狗（terminal.ts watchdogTick）的日志走同一个总开关与出口，
  // 不给「新埋点绕过 diagLog」留口子。
  terminal.onDiag = diagLog;

  const sendSecure = (conn: Conn, msg: ServerMsg) => {
    if (!conn.ready) return;
    conn.ws.send(conn.channel.send(new Uint8Array(Buffer.from(encode(msg), "utf8"))));
  };

  // 二进制帧的出站口。与 sendSecure 并列而非替代：JSON 帧路径一个字节不动。
  // 返回值 = 本帧明文字节数，供调用方做单帧预算判断后再决定发不发。
  const sendBinSecure = (conn: Conn, header: object, blob: Uint8Array) => {
    if (!conn.ready) return;
    conn.ws.send(conn.channel.send(packBinFrame(header, blob)));
  };

  // Fan a message out to every connected device (mirrors the sessions/snippets
  // broadcast loops below — same conns set, same sendSecure, no new delivery
  // path). Used by the update.apply orchestration to push `update{phase}`
  // progress frames.
  const broadcastAll = (msg: ServerMsg) => {
    for (const conn of conns.values()) sendSecure(conn, msg);
  };

  // Number every output chunk, then fan out to subscribed clients.
  // A2: bursts are batched per session (>=4KB or 8ms window) into ONE replay
  // frame, so seq semantics and the wire protocol are unchanged.
  // A6 backpressure: a conn whose socket buffer exceeds HIGH_WATER has output
  // frames dropped (control messages still go through); once the buffer drains
  // below LOW_WATER the conn gets a resync per affected session, then normal
  // delivery resumes. This cannot confuse the client's seq bookkeeping: the
  // client keeps a per-session max(seq) used only as lastSeq on (re)attach, it
  // never asserts contiguity, and on resync it keeps that max — exactly the
  // state a replay-eviction gap already produces, which a later attach heals
  // via replay.since(lastSeq).
  const HIGH_WATER_BYTES = 1024 * 1024;
  const LOW_WATER_BYTES = 256 * 1024;
  // Bun's server-side socket exposes its queued bytes ONLY through the
  // `getBufferedAmount()` METHOD — there is no `bufferedAmount` property (that
  // one belongs to the *client* `WebSocket` API). Reading it yielded
  // `undefined`, so the previous `conn.ws.bufferedAmount ?? 0` was a constant 0
  // and silently disabled every branch below: nothing was ever dropped and no
  // resync was ever issued, i.e. the whole A6 path was dead code. The guard
  // suite at the bottom of src/server-output.test.ts pins this shape against a
  // real Bun socket so it cannot drift back.
  const bufferedAmount = (conn: Conn): number => {
    const ws = conn.ws as { getBufferedAmount?: () => number };
    if (typeof ws.getBufferedAmount !== "function") return 0;
    try {
      const n = ws.getBufferedAmount();
      return typeof n === "number" && Number.isFinite(n) ? n : 0;
    } catch {
      // Socket already closed/detached: report "not backed up" so delivery keeps
      // its normal path (the send itself is a no-op on a dead socket).
      return 0;
    }
  };
  const maybeResync = (conn: Conn) => {
    if (conn.needsResyncSessions.size === 0) return;
    if (bufferedAmount(conn) > LOW_WATER_BYTES) return;
    for (const id of conn.needsResyncSessions) {
      if (conn.subscriptions.has(id)) {
        sendSecure(conn, { type: "resync", sessionId: id, from: replay.oldestSeq(id) });
      }
      // 结算沿：这一轮到底丢了多少。durMs 是丢弃持续时长 —— 它直接回答
      // 「屏幕上那个洞对应多长的时间窗」。
      const k = dropKey(conn, id);
      const st = dropStats.get(k);
      if (st) {
        dropStats.delete(k);
        diagLog({
          tag: id, kind: "drop", phase: "end",
          frames: st.frames, bytes: st.bytes, durMs: Date.now() - st.since,
          buffered: bufferedAmount(conn),
        });
      }
    }
    conn.needsResyncSessions.clear();
  };
  // 【2026-08-22】A6 丢帧此前**完全静默**：既不打日志，也不产生任何客户端可见
  // 的痕迹（客户端 seq 记账刻意不断言连续性）。排查「中间少几行」时，「agent
  // 日志里没有丢帧记录」曾被当成「没丢过」的证据 —— 那是错的，它只是没记。
  //
  // 逐帧打日志会在背压期间刷屏（那正是每秒几十帧的时刻），所以按会话聚合：
  // 进入丢弃状态时记一次，恢复（resync 发出）时把这一轮的帧数/字节数一起结算。
  const dropStats = new Map<string, { frames: number; bytes: number; since: number }>();
  const dropKey = (conn: Conn, id: string) => `${conn.remoteStatic ?? "?"}|${id}`;
  const deliverOutput = (conn: Conn, msg: ServerMsg & { type: "output" }) => {
    maybeResync(conn); // no-op unless the buffer has drained below low water
    if (conn.needsResyncSessions.size > 0 || bufferedAmount(conn) > HIGH_WATER_BYTES) {
      // Drop this frame for this conn only; replay still holds it, so a later
      // resync/reattach can backfill the hole.
      conn.needsResyncSessions.add(msg.sessionId);
      const k = dropKey(conn, msg.sessionId);
      let st = dropStats.get(k);
      if (!st) {
        st = { frames: 0, bytes: 0, since: Date.now() };
        dropStats.set(k, st);
        // 起始沿：立刻记一行，这样即使连接再没恢复过（结算行永远不来），日志里
        // 也留下了「这个会话在这个时刻开始丢帧」。
        diagLog({
          tag: msg.sessionId, kind: "drop", phase: "start",
          buffered: bufferedAmount(conn),
        });
      }
      st.frames++;
      st.bytes += msg.data.length;
      return;
    }
    sendSecure(conn, msg);
  };
  const batcher = new OutputBatcher((name, data) => {
    const frame = replay.ingest(name, data);
    const msg = { type: "output", sessionId: name, seq: frame.seq, data: toB64(data) } as const;
    let delivered = false;
    for (const conn of conns.values()) {
      if (conn.subscriptions.has(name)) { deliverOutput(conn, msg); delivered = true; }
    }
    // 【2026-08-28 投递盲区出声】pane 在产出、帧已进 replay，但没有任何连接
    // 订阅这个会话 = 字节被静默扣下（2026-08-26 的 rename bug 是它的一个
    // 变体）。5s 窗计数，只有帧数字节数。
    if (!delivered) {
      const c = deliverSkip.get(name) ?? { n: 0, bytes: 0 };
      c.n++; c.bytes += data.length;
      deliverSkip.set(name, c);
    }
  });
  const onTermOutput = (name: string, chunk: Uint8Array) => batcher.push(name, chunk);
  terminal.onOutput(onTermOutput);
  const onTermExit = (name: string, code: number) => {
    contextStore.delete(name);
    batcher.flush(name); // deliver the session's tail bytes before the exit notice
    batcher.clear(name);
    for (const conn of conns.values()) {
      if (conn.subscriptions.has(name)) sendSecure(conn, { type: "exit", sessionId: name, code });
    }
  };
  terminal.onExit(onTermExit);

  // WP-3a: list() is async (non-blocking tmux probes) and broadcasts are
  // diffed against the last push — an unchanged roster is neither encoded nor
  // sent (kills the 3s full-roster re-encode and the client re-render cascade
  // it caused). A trigger arriving mid-push asks for one trailing rerun: the
  // in-flight list() may have started before the change it would miss.
  let lastPushed: SessionMeta[] | null = null;
  let pushInFlight: Promise<void> | null = null;
  let pushAgain = false;
  const pushSessions = (): Promise<void> => {
    // Nobody to push to: skip the probe round entirely (matches the old code,
    // where list() was only evaluated inside the per-conn loop). The scanner
    // fires onSessionsChange regardless of connections, so without this gate
    // an idle agent would pay a full list() round for zero recipients.
    if (conns.size === 0) return Promise.resolve();
    if (pushInFlight) {
      pushAgain = true;
      return pushInFlight;
    }
    pushInFlight = (async () => {
      try {
        do {
          pushAgain = false;
          const sessions = contextStore.decorate([...(await terminal.list()), ...shell.list()]);
          if (lastPushed && sessionListsEqual(lastPushed, sessions)) continue;
          lastPushed = sessions;
          for (const conn of conns.values()) sendSecure(conn, { type: "sessions", sessions, features });
        } while (pushAgain);
      } catch {
        // A failed probe round must not reject callers or kill the interval;
        // the next trigger retries. (tmux runners are fail-safe by contract.)
      } finally {
        pushInFlight = null;
      }
    })();
    return pushInFlight;
  };
  terminal.onSessionsChange(pushSessions);

  // Isolated raw-PTY shell sessions (req 6). They reuse the exact same output
  // batcher/replay/fanout and exit path as tmux (keyed by sessionId), and a
  // create/kill/exit triggers a sessions broadcast so shell tabs appear/vanish.
  const shell = deps.shell ?? new ShellService();
  // 【2026-08-28 输入链路探针】aippt 一例：手机端「shell 能打、进 cc 后按键
  // 全部消失」，tap 里连回显都没有。逐键打日志会刷屏且含时序侧漏，这里攒
  // 每会话 5 秒窗口的「帧数/字节数」计数，窗口内有过输入就吐一条——对照
  // 客户端 input-send 与 pane-tap 增量，一次测试就能定位断点在哪一跳
  // （手机没发 / WS 丢了 / agent 没找到会话 / send-keys 没到 tmux）。
  // 只有计数，绝无内容。
  const inputRecv = new Map<string, { n: number; bytes: number }>();
  const deliverSkip = new Map<string, { n: number; bytes: number }>();
  setInterval(() => {
    for (const [session, c] of inputRecv) {
      if (c.n > 0) console.log(`[pocketshell:diag] ${JSON.stringify({ kind: "input-recv", session, n: c.n, bytes: c.bytes })}`);
      inputRecv.set(session, { n: 0, bytes: 0 });
    }
    for (const [session, c] of deliverSkip) {
      if (c.n > 0) console.log(`[pocketshell:diag] ${JSON.stringify({ kind: "deliver-skip", session, n: c.n, bytes: c.bytes })}`);
      deliverSkip.set(session, { n: 0, bytes: 0 });
    }
  }, 5_000).unref?.();
  // Presence keyed by device Noise pubkey (updated by the `presence` message,
  // cleared when a device's last live connection closes — req N's "smart
  // do-not-disturb": a device that is foregrounded AND looking at the very
  // session that finished does not get a system push, see notify-service.ts.
  const notifyPresence = new Map<string, DevicePresence>();
  const notify = new NotificationService({
    keyDir: config.keyDir,
    getPresences: () => [...notifyPresence.values()],
    broadcastInApp: (m) => broadcastAll({ type: "notification", ...m }),
    pushSender: realPushSender(ensureVapid(config.keyDir)),
  });
  // Per-tool hook config paths + the wire/unwire dispatcher backing the
  // notify.wire/notify.unwire RPCs below. Success persists the toggle into
  // notify.json so the UI reflects wired state after a restart.
  const agentBin = process.execPath;
  const toolPaths = {
    claude: pathJoin(homedir(), ".claude", "settings.json"),
    codex: pathJoin(homedir(), ".codex", "config.toml"),
    opencode: pathJoin(homedir(), ".config", "opencode", "plugin"),
    // kimi 的配置在 ~/.kimi/config.toml —— 官方文档写的是 ~/.kimi-code，
    // 但实现（share.py 的 get_share_dir）用的是 ~/.kimi。以实现为准。
    kimi: pathJoin(homedir(), ".kimi", "config.toml"),
  };
  const doWire = (tool: "claude" | "codex" | "opencode" | "kimi", on: boolean): WireResult => {
    let r: WireResult;
    if (tool === "claude") r = on ? wireClaude(toolPaths.claude, agentBin) : unwireClaude(toolPaths.claude, agentBin);
    else if (tool === "codex") r = on ? wireCodex(toolPaths.codex, agentBin) : unwireCodex(toolPaths.codex);
    else if (tool === "kimi") r = on ? wireKimi(toolPaths.kimi, agentBin) : unwireKimi(toolPaths.kimi);
    else r = on ? wireOpencode(toolPaths.opencode) : unwireOpencode(toolPaths.opencode);
    if (r.ok) { const c = notify.config(); c.tools[tool] = on; notify.setConfig(c); }
    return r;
  };
  // Notification hook wiring (req N): seed each new session's env with enough
  // for an in-session hook to identify itself as PocketShell and POST to the
  // loopback notify endpoint without holding a Noise identity of its own.
  const notifyEnv = (sessionId: string): Record<string, string> => ({
    POCKETSHELL_NOTIFY_SESSION: sessionId,
    POCKETSHELL_NOTIFY_URL: `http://127.0.0.1:${deps.port ?? config.listen.port}/internal/notify`,
    POCKETSHELL_NOTIFY_TOKEN: config.notifyToken,
  });
  shell.onOutput(onTermOutput);
  shell.onExit(onTermExit);
  shell.onChange(() => { void pushSessions(); });

  // Refresh the whole-machine roster + previews for connected clients. Skipped
  // entirely when nobody is connected (pushSessions only targets live conns,
  // but this also avoids the tmux spawns list() would do).
  const periodicPush = (): Promise<void> => (conns.size > 0 ? pushSessions() : Promise.resolve());
  const pushTimer = setInterval(periodicPush, 3000);
  (pushTimer as unknown as { unref?: () => void }).unref?.();

  // Transfer temp cleanup: startup full clean + periodic age-scoped sweep.
  sweepTmp(config.tmpDir, -1, Date.now());
  const sweepTimer = setInterval(() => sweepTmp(config.tmpDir, 3_600_000, Date.now()), 1_800_000);
  (sweepTimer as unknown as { unref?: () => void }).unref?.();

  // Preview tokens expire lazily on access; this proactively reclaims tokens
  // that are minted but never hit again (e.g. tab closed) so the map stays
  // bounded for long-lived connections instead of growing until disconnect.
  const previewSweepTimer = setInterval(() => previewTokens.sweep(Date.now()), 300_000);
  (previewSweepTimer as unknown as { unref?: () => void }).unref?.();

  // Everything that must happen when a device loses authorization. Dropping the
  // registry row alone is not enough: an already-open WebSocket has passed the
  // handshake and would keep working until it happened to reconnect, and its
  // push subscriptions would keep delivering. Used by the in-band revokeDevice
  // RPC and by the CLI-removal watcher, so the two paths cannot drift.
  const revokeEffects = (pub: string, via: string) => {
    config.audit.log({ event: "revoke", pub, ip: via });
    for (const c of conns.values()) if (c.remoteStatic === pub) c.ws.close();
    notify.removeSubsForDevice(pub);
  };

  // `pocketshell-agent devices remove` edits devices.json from another process.
  // Without this poll the resident agent never notices: the device stays in the
  // in-memory registry, keeps passing authorize(), and the next touch() writes
  // the removed record back to disk. See registry-watch.ts.
  const registryWatch = watchRegistryFile({
    stamp: () => readStamp(config.registryFile),
    current: () => config.registry.list().map((d) => d.pubKey),
    reload: () => config.registry.reload().map((d) => d.pubKey),
    onRemoved: (pubs) => {
      for (const pub of pubs) revokeEffects(pub, "cli");
    },
  });

  const pushSnippets = (target?: Conn) => {
    const items = config.snippets.list().map((r) => ({
      id: r.id, group: r.group, label: r.label, command: r.command, autoEnter: r.autoEnter,
    }));
    const msg: ServerMsg = { type: "snippets", items };
    if (target) sendSecure(target, msg);
    else for (const conn of conns.values()) sendSecure(conn, msg);
  };

  // 需求 5 限额。超限整批拒绝而不静默截断——截断后的命令语义可能完全不同
  // （`rm -rf /tmp/x` 截成 `rm -rf /`），必须让用户知道。
  const HINT_MAX_LEN = 200;      // 单条字符数
  const HINT_MAX_BATCH = 500;    // 单次提交条数
  const HINT_MAX_TOTAL = 2000;   // 库总量

  // hints 变更只广播一个无载荷通知，各端自行 rpc("hints.list") 重拉全量。
  const broadcastHintsChanged = () => broadcastAll({ type: "hintsChanged" });

  // update.apply orchestration: download+verify -> (macOS) re-sign -> smoke
  // check -> atomic same-dir swap -> restart. `applying` gates concurrent
  // triggers; the promise is fire-and-forget (the RPC caller only learns
  // whether the run *started* — progress rides `update{phase}` broadcasts).
  let applying = false;
  async function runApply(): Promise<{ started: boolean; reason?: string }> {
    const cache = readCache(config.keyDir);
    const gate = applyGate(config.update.repo, cache, applying, config.update.official);
    if (!gate.started) return gate;
    applying = true;
    const tag = `v${gate.latest}`;
    const emit = (phase: Phase, extra?: { pct?: number; message?: string }) =>
      broadcastAll({ type: "update", phase, version: gate.latest, ...extra });
    void (async () => {
      const target = process.execPath;
      const newPath = pathJoin(dirname(target), ".pocketshell.new");
      let swapped = false;
      try {
        // Download + checksum-verify into keyDir/updates/ (may be on a
        // different filesystem than execPath — see the copy+rename below).
        const { binaryPath } = await downloadAndVerify({
          repo: config.update.repo!,
          tag,
          keyDir: config.keyDir,
          onPhase: emit,
        });
        // Copy (not rename) into execPath's own directory so the final swap
        // below is a same-filesystem rename (atomic, no EXDEV). Sign the
        // *copy* here, never the keyDir original — signing then cross-mount
        // renaming would invalidate the signature's path assumptions and
        // risks EXDEV on the final move.
        copyFileSync(binaryPath, newPath);
        chmodSync(newPath, 0o755);
        emit("signing");
        await signBinary(newPath); // best-effort: false on non-darwin / no identity, degrades gracefully
        // Smoke check: refuse to swap over a binary that doesn't even run or
        // reports the wrong version.
        const out = await $`${newPath} --version`.nothrow().text();
        if (out.trim() !== gate.latest) {
          throw new Error(`smoke check failed: got "${out.trim()}", want "${gate.latest}"`);
        }
        emit("applying");
        try { copyFileSync(target, `${target}.prev`); } catch { /* best-effort backup */ }
        renameSync(newPath, target); // same-dir rename: atomic
        swapped = true;
        emit("restarting");
        restartSelf();
      } catch (e) {
        if (swapped) {
          // Swap succeeded but something after it failed (e.g. restart threw
          // instead of exiting) — restore the previous binary rather than
          // leave the box on an unverified swap with no rollback.
          try { renameSync(`${target}.prev`, target); } catch { /* best-effort rollback */ }
        }
        applying = false;
        emit("error", { message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return { started: true };
  }

  const finishPairing = (conn: Conn, deviceName: string) => {
    config.registry.add(conn.remoteStatic!, deviceName || "device");
    config.registry.touch(conn.remoteStatic!, conn.ip);
    conn.pending = false;
    conn.ready = true;
    if (conn.pairTimer) clearTimeout(conn.pairTimer);
    sendSecure(conn, { type: "paired", ok: true });
    clearPendingPairing(config.keyDir); // req 7-1: consume any disk pending too
    config.audit.log({ event: "pair_ok", pub: conn.remoteStatic, ip: conn.ip });
  };

  // WP-6 rpc chunking. Noise caps one frame at 65535B ciphertext (65519B
  // plaintext), so an oversize success response cannot ride a single frame —
  // instead of truncating it (the WP-1 stop-gap, now removed) the encoded
  // response bytes are sliced into an rpcChunk sequence the client reassembles.
  // Method-agnostic: covers fs.read/fs.diff/git.log/term.history and any future
  // large result. At/under RPC_FIT_SAFE_BYTES the single-frame fast path is
  // unchanged; ok:false replies are small and always go single-frame.
  const sendRpcResult = (
    conn: Conn,
    id: string,
    result: unknown,
    acceptEnc?: string[],
    method = "",
  ) => {
    const payload = encode({ type: "response", id, ok: true, result });
    // 压缩判定在分片判定**之前**：压完往往从"要分片"降级成"单帧"，
    // 省下的不只是字节，还有一整轮分片往返。
    const out = compressRpcPayload(payload, method, acceptEnc);
    if (out.kind === "zip") {
      // rpcZip/rpcChunk 的二进制帧同样要过 wantsBin 门——门控的是"客户端认不
      // 认识 0x00 开头的帧"，不是"载荷压没压"。acceptEnc 只含 "gzip" 时
      // （真实 v1.16.0 客户端的形状：只发 gzip，不发 bin）客户端的 onmessage
      // 末尾是无条件 TextDecoder().decode() 回 dispatch，没有首字节嗅探——
      // 撞上二进制帧会 decodeServer 抛、丢帧、rpc 挂到 10 秒超时，term.history
      // 每次挂载终端都会跑，等于老客户端被新 agent 砖化而不是降级。
      const wantsBin = Array.isArray(acceptEnc) && acceptEnc.includes("bin");
      // zipFitsOneFrame 的算式要跟着 wantsBin 分岔——不分岔会让 JSON 回落帧的
      // base64 膨胀被漏算，见 zipFitsOneFrame 自己的注释与 rpc-fit.test.ts 里
      // 崩溃带那条回归用例。
      if (zipFitsOneFrame(id, out.data, wantsBin)) {
        if (wantsBin) {
          sendBinSecure(conn, { type: "rpcZip", id }, out.data);
        } else {
          sendSecure(conn, { type: "rpcZip", id, data: Buffer.from(out.data).toString("base64") });
        }
        return;
      }
      // 压完仍超单帧预算：切成带 enc 标记的分片，客户端重组后再解压。
      //
      // 这里不能复用 chunkRpcPayload —— 它收字符串并在内部 Buffer.from(s,"utf8")，
      // 而 gzip 出来的是任意字节，先转 utf8 字符串会把非法序列替换成 U+FFFD，
      // 解压必炸。所以直接对字节切片。（这是刻意分岔，不要抽 helper 合并。）
      const gzBytes = out.data;
      const total = Math.max(1, Math.ceil(gzBytes.length / RPC_CHUNK_PAYLOAD_BYTES));
      for (let index = 0; index < total; index++) {
        const slice = gzBytes.subarray(
          index * RPC_CHUNK_PAYLOAD_BYTES,
          (index + 1) * RPC_CHUNK_PAYLOAD_BYTES,
        );
        if (wantsBin) {
          sendBinSecure(conn, { type: "rpcChunk", id, index, total, enc: "gzip" }, slice);
        } else {
          sendSecure(conn, { type: "rpcChunk", id, index, total, data: Buffer.from(slice).toString("base64"), enc: "gzip" });
        }
      }
      return;
    }
    // 未压缩：以下两条是原有逻辑，一字未改。
    if (Buffer.byteLength(payload, "utf8") <= RPC_FIT_SAFE_BYTES) {
      sendSecure(conn, { type: "response", id, ok: true, result });
      return;
    }
    // rpcChunk rides sendSecure like every control message — the WP-2
    // backpressure drop path only covers output frames, so shards cannot be
    // lost mid-sequence. They go out back-to-back in index order with no extra
    // flow control; the client's rpc timeout is the backstop.
    for (const chunk of chunkRpcPayload(id, payload)) sendSecure(conn, chunk);
  };

  // 含裸字节的成功回复。今天唯一的来源是 fs.downloadChunk。
  //
  // 必须自己做单帧预算判断：fsDownloadChunk 的 len 完全来自线上参数、服务端
  // 不校验上限。此前这条路径靠 chunkRpcPayload 自动切片兜住任意大的响应，
  // rpcBin 把那张网撤了——超了 Noise 65519 上限 cipher.js 会抛，退化成一个
  // 与原因毫无关系的 rpc_error，而不是崩溃，所以极难排查。
  const sendRpcBinary = (
    conn: Conn, id: string, meta: unknown, blob: Uint8Array, acceptEnc?: string[],
  ) => {
    const wantsBin = Array.isArray(acceptEnc) && acceptEnc.includes("bin");
    if (wantsBin) {
      const header = { type: "rpcBin" as const, id, result: meta };
      const frameBytes =
        BIN_FRAME_PREFIX_BYTES + Buffer.byteLength(JSON.stringify(header), "utf8") + blob.length;
      if (frameBytes <= RPC_FIT_SAFE_BYTES) {
        sendBinSecure(conn, header, blob);
        return;
      }
    }
    // 回落：装不下单帧，或客户端没声明 bin（老客户端）。退回一阶段的行为——
    // 把字节 base64 塞回 result，交给既有的压缩/分片链路。
    sendRpcResult(
      conn, id,
      { ...(meta as object), dataB64: Buffer.from(blob).toString("base64") },
      acceptEnc, "fs.downloadChunk",
    );
  };

  const handleClient = async (conn: Conn, raw: string, blob?: Uint8Array) => {
    let msg;
    try { msg = decodeClient(raw); }
    catch { sendSecure(conn, { type: "error", code: "bad_json", message: "malformed message" }); return; }
    switch (msg.type) {
      case "newSession":
        try {
          if (msg.kind === "shell") {
            // Cross-service name uniqueness: a shell must not shadow an existing
            // tmux (owned or foreign) or shell session — otherwise input/kill
            // would route to the shell and orphan the tmux, and the broadcast
            // would carry two same-named entries.
            if (shell.has(msg.name) || terminal.has(msg.name)) {
              sendSecure(conn, { type: "error", code: "name_taken", message: `session "${msg.name}" already exists` });
              break;
            }
            shell.create(msg.name, { env: notifyEnv(msg.name) });
          } else {
            // tmux with an existing tmux name is a legitimate adopt/attach (do
            // NOT reject); only reject when the name is taken by a shell session.
            if (shell.has(msg.name)) {
              sendSecure(conn, { type: "error", code: "name_taken", message: `session "${msg.name}" already exists` });
              break;
            }
            // 客户端捎来的本机尺寸：可信才用，否则退回 ensure 内部的 80x24 默认。
            const hinted = isSaneSize(msg.cols, msg.rows);
            terminal.ensure(msg.name, {
              cmd: msg.cmd, cwd: msg.cwd, env: notifyEnv(msg.name),
              cols: hinted ? msg.cols : undefined,
              rows: hinted ? msg.rows : undefined,
            });
          }
        }
        catch (e) { sendSecure(conn, { type: "error", code: "ensure_failed", message: String(e) }); }
        break;
      case "listSessions":
        // Unicast request/response: always answered with a fresh list, never
        // gated by the push diff cache.
        void terminal
          .list()
          .then((sessions) => sendSecure(conn, { type: "sessions", sessions: contextStore.decorate([...sessions, ...shell.list()]), features }))
          .catch(() => { /* runners are fail-safe; never crash the handler */ });
        break;
      case "renameSession":
        try {
          terminal.rename(msg.sessionId, msg.name);
          // Subscriptions follow the session identity across a rename: output
          // is emitted under the new name from now on and clients do not
          // re-attach, so without this the session would silently stop
          // streaming to every subscribed conn.
          for (const c of conns.values()) {
            if (c.subscriptions.delete(msg.sessionId)) c.subscriptions.add(msg.name);
            if (c.needsResyncSessions.delete(msg.sessionId)) c.needsResyncSessions.add(msg.name);
          }
        }
        catch (e) { sendSecure(conn, { type: "error", code: "rename_failed", message: String(e) }); }
        break;
      case "attach": {
        conn.subscriptions.add(msg.sessionId);
        // The replay backfill below is itself the resync for this conn, so any
        // pending backpressure-resync flag for the session is stale.
        conn.needsResyncSessions.delete(msg.sessionId);
        const lastSeq = msg.lastSeq ?? 0;
        const { frames, gap, oldestSeq } = replay.since(msg.sessionId, lastSeq);
        if (gap) sendSecure(conn, { type: "resync", sessionId: msg.sessionId, from: oldestSeq });
        // gap 时只补发最新的一段（预算与「为什么不能干脆不发」的四个反例见
        // replay.ts 的 GAP_BACKFILL_BUDGET_BYTES 注释）。**非 gap 路径一个字节
        // 都不能动**——那是正常的断线补齐，客户端不会重灌，少一帧就是真丢字节。
        const send = gap ? tailWithinBudget(frames, GAP_BACKFILL_BUDGET_BYTES) : frames;
        for (const f of send) sendSecure(conn, { type: "output", sessionId: f.sessionId, seq: f.seq, data: toB64(f.data) });
        // attach 分支此前不打任何日志，整条「整环重放制造字节洪水」的根因链只能
        // 靠客户端埋点 + 数值指纹推断。这一行给出服务端直接佐证，也是验证上面
        // 限量是否生效的唯一依据。attach 只在重连/挂载时发生（重复 attach 被
        // connection.ts 的 subscribed 判断挡在客户端），不会刷屏。
        diagLog({
          tag: msg.sessionId, kind: "attach", lastSeq, gap,
          frames: send.length,
          bytes: send.reduce((n, f) => n + f.data.byteLength, 0),
        });
        break;
      }
      case "detach":
        conn.subscriptions.delete(msg.sessionId);
        conn.needsResyncSessions.delete(msg.sessionId);
        break;
      case "pair":
        // Reaching handleClient means this conn is already authorized (its device
        // is registered) — the pending-pairing path is handled earlier in
        // onMessage. A 'pair' here is a redundant re-send from a client whose
        // pendingPair was never cleared (its original 'paired' reply was lost in
        // a reconnect drop). Answer idempotently so the client clears pendingPair
        // and goes online, instead of looping on an "unknown_type" error.
        sendSecure(conn, { type: "paired", ok: true });
        break;
      case "input": {
        const data = fromB64(msg.data);
        // 输入链路探针（见上方 inputRecv 的注释）：只计数。
        const c = inputRecv.get(msg.sessionId) ?? { n: 0, bytes: 0 };
        c.n++; c.bytes += data.length;
        inputRecv.set(msg.sessionId, c);
        if (shell.has(msg.sessionId)) shell.write(msg.sessionId, data);
        else terminal.write(msg.sessionId, data);
        break;
      }
      case "resize":
        // 纵深防御：塌陷尺寸会让上游程序按错误宽度把硬换行打进 tmux 历史，而那
        // **不可逆**（tmux 只能反折自己折的软折行）。客户端已在 fit-guard.ts 修掉
        // 根因，这里再挡一道，保证任何版本/任何实现的客户端都毁不掉用户的历史。
        // 丢弃而非夹取：夹到 20 列照样污染，保住上一次的正确尺寸才是对的。
        if (!isSaneSize(msg.cols, msg.rows)) break;
        if (shell.has(msg.sessionId)) shell.resize(msg.sessionId, msg.cols, msg.rows);
        else terminal.resize(msg.sessionId, msg.cols, msg.rows);
        break;
      case "kill":
        if (shell.has(msg.sessionId)) shell.kill(msg.sessionId);
        else void terminal.kill(msg.sessionId);
        break;
      case "ping": sendSecure(conn, { type: "pong" }); break;
      case "presence":
        if (conn.remoteStatic) {
          notifyPresence.set(conn.remoteStatic, { pubKey: conn.remoteStatic, foreground: msg.foreground, activeSessionId: msg.activeSessionId });
        }
        break;
      case "listDevices": {
        const envKeysArr = Array.from(envKeys);
        const list: DeviceInfo[] = [
          ...config.registry.list().map((d) => ({ ...d, source: "registry" as const, self: d.pubKey === conn.remoteStatic })),
          ...envKeysArr.map((pub) => ({ pubKey: pub, name: "env", addedAt: "", lastSeen: null, source: "env" as const, self: pub === conn.remoteStatic })),
        ];
        sendSecure(conn, { type: "devices", devices: list });
        break;
      }
      case "revokeDevice": {
        if (envKeys.has(msg.pubKey)) { sendSecure(conn, { type: "error", code: "revoke_denied", message: "env keys are read-only" }); break; }
        const removed = config.registry.remove(msg.pubKey);
        if (removed) {
          config.audit.log({ event: "revoke", pub: msg.pubKey, ip: conn.ip });
          for (const c of conns.values()) if (c.remoteStatic === msg.pubKey) c.ws.close();
          notify.removeSubsForDevice(msg.pubKey);
        }
        break;
      }
      case "listSnippets":
        pushSnippets(conn);
        break;
      case "addSnippet":
        try {
          config.snippets.add({ group: msg.group, label: msg.label, command: msg.command, autoEnter: msg.autoEnter });
          pushSnippets();
        } catch (e) { sendSecure(conn, { type: "error", code: "snippet_add_failed", message: String(e) }); }
        break;
      case "updateSnippet":
        try {
          if (config.snippets.update(msg.id, { group: msg.group, label: msg.label, command: msg.command, autoEnter: msg.autoEnter })) pushSnippets();
          else sendSecure(conn, { type: "error", code: "snippet_not_found", message: msg.id });
        } catch (e) { sendSecure(conn, { type: "error", code: "snippet_update_failed", message: String(e) }); }
        break;
      case "removeSnippet":
        if (config.snippets.remove(msg.id)) pushSnippets();
        break;
      case "addHints": {
        const texts = Array.isArray(msg.texts) ? msg.texts.filter((t): t is string => typeof t === "string") : [];
        if (texts.length > HINT_MAX_BATCH) {
          sendSecure(conn, { type: "error", code: "hints_limit", message: `batch > ${HINT_MAX_BATCH}` });
          break;
        }
        if (texts.some((t) => t.length > HINT_MAX_LEN)) {
          sendSecure(conn, { type: "error", code: "hints_limit", message: `entry > ${HINT_MAX_LEN} chars` });
          break;
        }
        if (config.hints.count() + texts.length > HINT_MAX_TOTAL) {
          sendSecure(conn, { type: "error", code: "hints_limit", message: `total > ${HINT_MAX_TOTAL}` });
          break;
        }
        try {
          if (config.hints.addMany(texts).length > 0) broadcastHintsChanged();
        } catch (e) { sendSecure(conn, { type: "error", code: "hints_add_failed", message: String(e) }); }
        break;
      }
      case "updateHint": {
        if (typeof msg.text !== "string" || msg.text.length > HINT_MAX_LEN) {
          sendSecure(conn, { type: "error", code: "hints_limit", message: `entry > ${HINT_MAX_LEN} chars` });
          break;
        }
        if (config.hints.update(msg.id, msg.text)) broadcastHintsChanged();
        else sendSecure(conn, { type: "error", code: "hint_not_found", message: msg.id });
        break;
      }
      case "removeHint":
        if (config.hints.remove(msg.id)) broadcastHintsChanged();
        break;
      case "clearHints":
        config.hints.clear();
        broadcastHintsChanged();
        break;
      case "rpc": {
        const { id, method, params, acceptEnc } = msg;
        // 二进制帧带来的 blob 注入 params，让 parse.* 能像读普通字段一样读它。
        // 用一个不可能与线上字段冲突的键，避免恶意的 JSON rpc 伪造它。
        const p2 = blob === undefined
          ? params
          : { ...(params as object), __blob: blob };
        // Table-driven dispatch lives in rpc-router.ts. This stays the only
        // place that knows how to put bytes on this conn's channel: every
        // handler answers through sendResult/sendError below — including the
        // four that answer themselves (notify.testWebhook / update.check /
        // update.apply, all async) and the unknown-method fallback.
        return dispatchRpc(
          {
            config: rpcConfig, terminal, shell, replay, notify, previewTokens,
            claudeSettingsPath: toolPaths.claude, agentBin, doWire, runApply,
            id,
            devicePub: conn.remoteStatic,
            sendResult: (result) => sendRpcResult(conn, id, result, acceptEnc, method),
            sendBinary: (meta, blob) => sendRpcBinary(conn, id, meta, blob, acceptEnc),
            sendError: (code, message) => sendSecure(conn, { type: "response", id, ok: false, error: { code, message } }),
          },
          method,
          p2,
        );
      }
      default: sendSecure(conn, { type: "error", code: "unknown_type", message: "unknown message type" }); break;
    }
  };

  const onOpen = (ws: ServerWebSocket<unknown>, ip = "", factory = channelFactory) => {
    if (ip && config.rateLimiter.isLocked(ip)) { ws.close(); return; }
    const conn: Conn = { ws, channel: factory(), ready: false, pending: false, remoteStatic: null, ip, subscriptions: new Set(), needsResyncSessions: new Set() };
    conns.set(ws, conn);
    const m1 = conn.channel.start();
    if (m1) ws.send(m1); // responder returns null; kept for symmetry
  };

  const onMessage = (ws: ServerWebSocket<unknown>, raw: Uint8Array | string) => {
    const conn = conns.get(ws);
    if (!conn) return;
    const frame = typeof raw === "string" ? new Uint8Array(Buffer.from(raw, "utf8")) : new Uint8Array(raw as Uint8Array);
    const r = conn.channel.receive(frame);
    if (r.status === "fail") {
      console.warn("[pocketshell] channel fail:", r.reason);
      // Only handshake-phase failures (random keys / bad handshake) feed the
      // brute-force limiter. A transport-phase decrypt failure happens only
      // after a peer already completed the handshake (authorized or pending),
      // so it is not a handshake brute-force vector — don't count/mislabel it.
      const established = conn.ready || conn.pending;
      if (!established) {
        config.audit.log({ event: "handshake_fail", ip: conn.ip, reason: r.reason });
        config.rateLimiter.record(conn.ip);
      }
      ws.close();
      return;
    }
    if (r.status === "handshake") {
      if (r.reply) ws.send(r.reply);
      if (r.established) {
        conn.remoteStatic = r.remoteStatic ?? null;
        if (r.pending) {
          conn.pending = true;
          conn.pairTimer = setTimeout(() => { if (conn.pending) conn.ws.close(); }, pairTimeoutMs);
          console.log("[pocketshell] pending device awaiting pair");
        } else {
          conn.ready = true;
          if (conn.remoteStatic) config.registry.touch(conn.remoteStatic, conn.ip);
          config.audit.log({ event: "handshake_ok", pub: conn.remoteStatic, ip: conn.ip });
          console.log("[pocketshell] connect (authorized)");
        }
      }
      return;
    }
    // r.status === "message"
    //
    // 明文有两种布局：JSON 帧（首字节 '{'）与二进制帧（首字节 0x00）。二进制帧
    // 的判别必须在 toString("utf8") **之前**——那个转换会把 gzip/文件字节里的
    // 非法序列替换成 U+FFFD，不可逆。
    const plain = new Uint8Array(r.plaintext);
    if (plain.length > 0 && plain[0] === BIN_FRAME_MAGIC) {
      // 安全边界：判 !ready 而不是 pending。写盘发生在 dispatchRpc 里、早于
      // sendResult，而 sendSecure 的 !ready 只是**出口**守卫，挡不住副作用。
      // 用 !ready 对 pending 与任何未来的中间态都成立，不需要重新论证。
      if (!conn.ready) { ws.close(); return; }
      const bf = unpackBinFrame(plain);
      // 坏帧一律关连接，与 decodeClient 失败的处置一致（不回错误帧，不给
      // 探测者反馈）。
      if (!bf) { ws.close(); return; }
      void handleClient(conn, JSON.stringify(bf.header), bf.blob).catch((e) => {
        try { sendSecure(conn, { type: "error", code: "internal", message: String(e) }); } catch {}
      });
      return;
    }
    const text = Buffer.from(r.plaintext).toString("utf8");
    if (conn.pending) {
      let msg: ReturnType<typeof decodeClient>;
      try { msg = decodeClient(text); } catch { conn.ws.close(); return; }
      if (msg.type !== "pair") { conn.ws.close(); return; }
      const v = config.pairing ? config.pairing.verify(msg.code) : { ok: false as const, reason: "no_attempts" as const };
      if (v.ok) { finishPairing(conn, msg.deviceName); }
      else {
        config.audit.log({ event: "pair_fail", ip: conn.ip, reason: v.reason });
        config.rateLimiter.record(conn.ip);
        conn.ws.send(conn.channel.send(new Uint8Array(Buffer.from(encode({ type: "error", code: "pair_failed", message: v.reason }), "utf8"))));
        conn.ws.close();
      }
      return;
    }
    // handleClient 是 async（term.history 走 tmuxAsync），而它的 switch 主体不在
    // 总 try/catch 里：一次 reject（tmux 缺失、spawn 失败）会变成未处理的 Promise
    // rejection 直接掀掉进程，而不是像同步时代那样被这里兜住。回一条 rpc 风格的
    // error 帧让客户端能自愈，不静默吞掉。
    void handleClient(conn, text).catch((e) => {
      try {
        sendSecure(conn, { type: "error", code: "internal", message: String(e) });
      } catch {
        // 连回错都失败（信道已废）——放弃，别再抛
      }
    });
  };

  const tlsMaterial = resolveTlsMaterial(config.keyDir, config.tls);
  const server = Bun.serve({
    hostname: config.listen.host,
    port: deps.port ?? config.listen.port,
    tls: tlsMaterial ?? undefined,
    async fetch(req, srv) {
      if (srv.upgrade(req)) return;
      const url = new URL(req.url);
      if (url.pathname === "/internal/notify" && req.method === "POST") {
        const ip = srv.requestIP(req)?.address ?? "";
        if (!isLocalAddr(ip)) return new Response("Forbidden", { status: 403 });
        if (req.headers.get("authorization") !== `Bearer ${config.notifyToken}`) return new Response("Unauthorized", { status: 401 });
        const b = (await req.json().catch(() => null)) as {
          sessionId?: string; title?: string; body?: string;
          tool?: string; ctxUsed?: number; ctxTotal?: number; contextOnly?: boolean;
        } | null;
        if (!b?.sessionId) return new Response("bad", { status: 400 });
        if (isAiTool(b.tool) && (typeof b.ctxUsed === "number" || typeof b.ctxTotal === "number")) {
          contextStore.set(b.sessionId, b.tool, {
            used: typeof b.ctxUsed === "number" ? b.ctxUsed : 0,
            total: typeof b.ctxTotal === "number" ? b.ctxTotal : undefined,
          }, Date.now());
          void pushSessions();
        }
        if (!b.contextOnly) {
          void notify.dispatch({ sessionId: b.sessionId, title: b.title ?? b.sessionId, body: b.body ?? "" });
        }
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/preview/")) {
        return buildPreviewResponse(previewTokens, url, Date.now(), req.headers.get("range"));
      }
      // The user's own themes as a stylesheet. Unauthenticated on purpose, and
      // it is worth being explicit about why: the app pulls it with a plain
      // <link> in <head> (design §4.3 — a blocking stylesheet is what makes a
      // custom theme survive the first frame), and a <link> can carry neither a
      // bearer token nor the Noise session. The content is a colour palette the
      // user copied out of a public theme repository, sitting behind whatever
      // guards the app itself; there is nothing here to protect. Writes are a
      // different matter — see /theme/import below.
      if (url.pathname === "/theme/custom.css" && (req.method === "GET" || req.method === "HEAD")) {
        return buildThemeCssResponse(config.themes, url, req.headers.get("if-none-match"));
      }
      // Import over HTTP: loopback + bearer, exactly like /internal/notify.
      // That makes it a *local* path — a script or a shell one-liner on the
      // machine running the agent — because those are the two credentials a
      // local process can get at (the token is in <keyDir>/notify_token, and the
      // agent hands it to the tools it wires up).
      //
      // A phone cannot use it: it is not on loopback and it does not have the
      // token. The settings-panel import therefore goes over the authed WS
      // instead (`theme.import` in rpc-router.ts), where the device's Noise key
      // is already the credential. Two transports for one operation is not
      // ideal, but the alternative was a write endpoint whose only guard is a
      // loopback check — which is exactly the hole the admin page was retired
      // for (VULN-001, see net-addr.ts).
      if (url.pathname === "/theme/import" && req.method === "POST") {
        const ip = srv.requestIP(req)?.address ?? "";
        if (!isLocalAddr(ip)) return new Response("Forbidden", { status: 403 });
        if (req.headers.get("authorization") !== `Bearer ${config.notifyToken}`) return new Response("Unauthorized", { status: 401 });
        const body = (await req.json().catch(() => null)) as { name?: unknown; text?: unknown } | null;
        if (!body) return new Response("bad", { status: 400 });
        const r = importTheme(config.themes, body);
        return Response.json(r, { status: r.ok ? 200 : 400 });
      }
      const r = resolveStatic(
        url.pathname,
        req.headers.get("accept") ?? "",
        assetKeys,
        req.headers.get("accept-encoding") ?? "",
      );
      // 实例身份：manifest 与 index.html 的名称字段按 instanceName 改写。**只有
      // 设了实例名才走这条分支** —— 不设时必须原样落到下面那条 Bun.file 路径，
      // 否则 content-type 会从 Bun 的推断值漂到这里手写的 MIME（html 那条差一个
      // 空格），破坏「不设即与改动前逐字节相同」的约束。
      // ETag 必须按改写后的 body 算：用磁盘文件内容算会让改名后客户端拿 304 旧值。
      // 这两个文件都是 no-cache（非 /assets/ 下的 content-hash 资源），改写成本可忽略。
      // 2026-07-30 实测：compress-dist.ts 的阈值是 10 KB，index.html(4.2 KB) 与
      // manifest(676 B) 都不到，不生成 .br/.gz，所以 r.assetKey 就是未压缩键。
      // 若哪天 index.html 涨过 10 KB，resolveStatic 会把 assetKey 指向 .br，
      // BRANDED_ASSETS 不再命中 —— 那时改成按 url.pathname 判定并始终读原文件。
      if (
        config.instanceName &&
        r.status === 200 &&
        r.assetKey &&
        BRANDED_ASSETS.has(r.assetKey) &&
        !r.headers["Content-Encoding"]
      ) {
        const raw = await Bun.file(assets[r.assetKey]).text();
        const body =
          r.assetKey === "/manifest.webmanifest"
            ? brandManifest(raw, { name: config.instanceName })
            : brandHtml(raw, { name: config.instanceName });
        const bytes = new TextEncoder().encode(body);
        const etag = contentEtag(bytes);
        if (isNotModified(req.headers.get("if-none-match"), etag)) {
          return new Response(null, { status: 304, headers: { ...r.headers, ETag: etag } });
        }
        const headers: Record<string, string> = { ...r.headers, ETag: etag };
        headers["content-type"] =
          r.assetKey === "/manifest.webmanifest"
            ? "application/manifest+json"
            : "text/html; charset=utf-8";
        return new Response(bytes, { headers });
      }
      if (r.status === 200 && r.assetKey) {
        const etag = await etagFor(r.assetKey);
        if (isNotModified(req.headers.get("if-none-match"), etag)) {
          return new Response(null, { status: 304, headers: { ...r.headers, ETag: etag } });
        }
        const headers: Record<string, string> = { ...r.headers, ETag: etag };
        // .br/.gz variants: Bun.file infers Content-Type from the variant
        // extension, so the resolver passes the original type explicitly.
        if (r.contentType) headers["content-type"] = r.contentType;
        return new Response(Bun.file(assets[r.assetKey]), { headers });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) { onOpen(ws, (ws as any).remoteAddress ?? ""); },
      close(ws) {
        const conn = conns.get(ws);
        conns.delete(ws);
        // Reclaim this device's preview tokens once it has no live socket left.
        if (conn?.remoteStatic && ![...conns.values()].some((c) => c.remoteStatic === conn.remoteStatic)) {
          previewTokens.revokeDevice(conn.remoteStatic);
          notifyPresence.delete(conn.remoteStatic);
        }
        console.log("[pocketshell] disconnect");
      },
      message(ws, raw) { onMessage(ws, raw as any); },
      // Socket drained after backpressure: recover any dropped-output sessions.
      drain(ws) { const conn = conns.get(ws); if (conn) maybeResync(conn); },
    },
  });

  // Startup update check: warms the cache so the first client `update.check`
  // RPC after boot can serve a fresh result without waiting on GitHub.
  // Fire-and-forget, failure-silent (checkLatest already swallows its own
  // network/parse errors into a CheckResult with a `reason`, but this outer
  // guard also covers writeCache/config surprises).
  // config.update is always populated by loadConfig(), but several server.test.ts
  // suites construct a minimal `cfg: any` without it — optional-chain the guard
  // so those keep exercising unrelated behavior without also opting into a
  // startup network call.
  if (config.update?.repo) {
    const repo = config.update.repo;
    void (async () => {
      try {
        const r = await checkLatest({ repo, current: AGENT_VERSION });
        writeCache(config.keyDir, { ...r, checkedAt: Date.now() });
      } catch { /* best-effort warmup; a later update.check RPC will retry */ }
    })();
  }

  return {
    port: server.port,
    url: server.url,
    stop() {
      clearInterval(pushTimer);
      clearInterval(sweepTimer);
      clearInterval(previewSweepTimer);
      registryWatch.stop();
      batcher.clearAll();
      terminal.dispose();
      shell.dispose();
      server.stop(true);
    },
    __test: {
      open: (ws: any, ip = "") => onOpen(ws, ip),
      openWith: (ws: any, ip: string, factory: () => SecureChannel) => onOpen(ws, ip, factory),
      message: onMessage,
      broadcastOutputForTest: () => { for (const conn of conns.values()) sendSecure(conn, { type: "pong" }); },
      periodicPush,
      emitOutput: onTermOutput,
      emitExit: onTermExit,
      flushOutput: (name: string) => batcher.flush(name),
      drain: (ws: any) => { const conn = conns.get(ws); if (conn) maybeResync(conn); },
      pollRegistry: () => registryWatch.poll(),
      config,
    },
  };
}

// Allow `bun run src/server.ts` (or the compiled binary) to boot directly.
// All subcommand bodies (install/uninstall, notify, statusline, devices/pair,
// --version, --warmup) and the default boot path now live in cli-entry.ts;
// this is only the entry hook. startServer is passed in because cli-entry.ts
// must not import back from here (cycle).
if (import.meta.main) {
  runCli(process.argv, startServer);
}
