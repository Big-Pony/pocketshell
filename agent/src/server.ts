// A3 (slice-1, plaintext): a Bun WebSocket server wiring the wire protocol to
// TerminalService (A2) + ReplayService (A4). Noise handshake + pairing land in
// a later slice; the message shapes here are the frozen contract from A3 §3.
// S4a: wrapped in SecureChannel handshake — plaintext message loop unchanged.
// S4b: in-channel pairing — pending state, pair verify, registry∪env authorize.
import type { ServerWebSocket } from "bun";
import { loadConfig, type AgentConfig, resolveTlsMaterial, buildPairingString, resolveAdvertise, advertiseToHttp } from "./config";
import { TerminalService } from "./terminal";
import { ReplayService } from "./replay";
import { OutputBatcher } from "./output-batcher";
import { fsTree, fsRead, fsDiff, fsOp, fsUploadCheck, fsResolveName, fsUploadChunk, fsDownloadChunk, fsArchive, sweepTmp, fsWrite } from "./fs-service";
import { gitLog, gitBranches, gitStatus } from "./git-service";
import { RPC_FIT_SAFE_BYTES, chunkRpcPayload } from "./rpc-fit";
import { decodeClient, encode, type ServerMsg, type DeviceInfo, type SessionMeta } from "./protocol";
import { sessionListsEqual } from "./sessions-diff";
import { toB64, fromB64 } from "./bytes";
import { createResponderChannel, type SecureChannel } from "./secure-channel";
import { resolveStatic, contentEtag, isNotModified } from "./static-serve";
import { ASSETS } from "./embedded-manifest";
import { ensureTmux, realTmuxDeps } from "./ensure-tmux";
import { buildReadiness, isNonLocalBind } from "./readiness";
import { runWarmup } from "./warmup";
import { createPairing } from "./pairing";
import { isLocalAddr, deviceRows, ADMIN_HTML } from "./admin";
import { PreviewTokens } from "./preview-service";
import { buildPreviewResponse } from "./server-preview";
import { AGENT_VERSION } from "./version";

interface Deps {
  port?: number;
  config?: AgentConfig;
  terminal?: TerminalService;
  replay?: ReplayService;
  channelFactory?: () => SecureChannel;
  pairTimeoutMs?: number;
  assets?: Record<string, string>;
}

export function startServer(deps: Deps = {}) {
  const config = deps.config ?? loadConfig();
  const terminal = deps.terminal ?? new TerminalService();
  const replay = deps.replay ?? new ReplayService(config.replayBufferBytes);

  const envKeys = new Set(config.authorizedKeys);
  const authorize = (pub: string): "authorized" | "pending" | "reject" => {
    if (config.registry.has(pub) || envKeys.has(pub)) return "authorized";
    // Admit an unregistered peer to the pending window only while the pairing
    // code is still live (not consumed/expired). Once spent, unregistered peers
    // are rejected at the handshake rather than kept admissible for the whole
    // process lifetime.
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

  const sendSecure = (conn: Conn, msg: ServerMsg) => {
    if (!conn.ready) return;
    conn.ws.send(conn.channel.send(new Uint8Array(Buffer.from(encode(msg), "utf8"))));
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
  const bufferedAmount = (conn: Conn) => conn.ws.bufferedAmount ?? 0;
  const maybeResync = (conn: Conn) => {
    if (conn.needsResyncSessions.size === 0) return;
    if (bufferedAmount(conn) > LOW_WATER_BYTES) return;
    for (const id of conn.needsResyncSessions) {
      if (conn.subscriptions.has(id)) {
        sendSecure(conn, { type: "resync", sessionId: id, from: replay.oldestSeq(id) });
      }
    }
    conn.needsResyncSessions.clear();
  };
  const deliverOutput = (conn: Conn, msg: ServerMsg & { type: "output" }) => {
    maybeResync(conn); // no-op unless the buffer has drained below low water
    if (conn.needsResyncSessions.size > 0 || bufferedAmount(conn) > HIGH_WATER_BYTES) {
      // Drop this frame for this conn only; replay still holds it, so a later
      // resync/reattach can backfill the hole.
      conn.needsResyncSessions.add(msg.sessionId);
      return;
    }
    sendSecure(conn, msg);
  };
  const batcher = new OutputBatcher((name, data) => {
    const frame = replay.ingest(name, data);
    const msg = { type: "output", sessionId: name, seq: frame.seq, data: toB64(data) } as const;
    for (const conn of conns.values()) {
      if (conn.subscriptions.has(name)) deliverOutput(conn, msg);
    }
  });
  const onTermOutput = (name: string, chunk: Uint8Array) => batcher.push(name, chunk);
  terminal.onOutput(onTermOutput);
  const onTermExit = (name: string, code: number) => {
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
          const sessions = await terminal.list();
          if (lastPushed && sessionListsEqual(lastPushed, sessions)) continue;
          lastPushed = sessions;
          for (const conn of conns.values()) sendSecure(conn, { type: "sessions", sessions });
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

  const pushSnippets = (target?: Conn) => {
    const items = config.snippets.list().map((r) => ({
      id: r.id, group: r.group, label: r.label, command: r.command, autoEnter: r.autoEnter,
    }));
    const msg: ServerMsg = { type: "snippets", items };
    if (target) sendSecure(target, msg);
    else for (const conn of conns.values()) sendSecure(conn, msg);
  };

  const finishPairing = (conn: Conn, deviceName: string) => {
    config.registry.add(conn.remoteStatic!, deviceName || "device");
    config.registry.touch(conn.remoteStatic!, conn.ip);
    conn.pending = false;
    conn.ready = true;
    if (conn.pairTimer) clearTimeout(conn.pairTimer);
    sendSecure(conn, { type: "paired", ok: true });
    config.audit.log({ event: "pair_ok", pub: conn.remoteStatic, ip: conn.ip });
  };

  // WP-6 rpc chunking. Noise caps one frame at 65535B ciphertext (65519B
  // plaintext), so an oversize success response cannot ride a single frame —
  // instead of truncating it (the WP-1 stop-gap, now removed) the encoded
  // response bytes are sliced into an rpcChunk sequence the client reassembles.
  // Method-agnostic: covers fs.read/fs.diff/git.log/term.history and any future
  // large result. At/under RPC_FIT_SAFE_BYTES the single-frame fast path is
  // unchanged; ok:false replies are small and always go single-frame.
  const sendRpcResult = (conn: Conn, id: string, result: unknown) => {
    const payload = encode({ type: "response", id, ok: true, result });
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

  const handleClient = (conn: Conn, raw: string) => {
    let msg;
    try { msg = decodeClient(raw); }
    catch { sendSecure(conn, { type: "error", code: "bad_json", message: "malformed message" }); return; }
    switch (msg.type) {
      case "newSession":
        try { terminal.ensure(msg.name, { cmd: msg.cmd, cwd: msg.cwd }); }
        catch (e) { sendSecure(conn, { type: "error", code: "ensure_failed", message: String(e) }); }
        break;
      case "listSessions":
        // Unicast request/response: always answered with a fresh list, never
        // gated by the push diff cache.
        void terminal
          .list()
          .then((sessions) => sendSecure(conn, { type: "sessions", sessions }))
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
        const { frames, gap, oldestSeq } = replay.since(msg.sessionId, msg.lastSeq ?? 0);
        if (gap) sendSecure(conn, { type: "resync", sessionId: msg.sessionId, from: oldestSeq });
        for (const f of frames) sendSecure(conn, { type: "output", sessionId: f.sessionId, seq: f.seq, data: toB64(f.data) });
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
      case "input": terminal.write(msg.sessionId, fromB64(msg.data)); break;
      case "resize": terminal.resize(msg.sessionId, msg.cols, msg.rows); break;
      case "kill": void terminal.kill(msg.sessionId); break;
      case "ping": sendSecure(conn, { type: "pong" }); break;
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
      case "removeSnippet":
        if (config.snippets.remove(msg.id)) pushSnippets();
        break;
      case "rpc": {
        const { id, method, params } = msg;
        const p = (params ?? {}) as any;
        try {
          let result: unknown;
          switch (method) {
            case "fs.tree": result = fsTree(String(p.path)); break;
            case "fs.read": result = fsRead(String(p.path)); break;
            case "fs.diff": result = fsDiff(String(p.path), p.cwd ? String(p.cwd) : undefined); break;
            case "fs.op": result = fsOp(p.op, String(p.path), p.to ? String(p.to) : undefined); break;
            case "fs.uploadCheck": result = fsUploadCheck(String(p.dir), (p.names ?? []) as string[]); break;
            case "fs.resolveName": result = fsResolveName(String(p.dir), String(p.name)); break;
            case "fs.uploadChunk": result = fsUploadChunk(config.tmpDir, String(p.uploadId), String(p.dataB64), { first: !!p.first, last: !!p.last, destPath: p.destPath ? String(p.destPath) : undefined }); break;
            case "fs.write": result = fsWrite(config.tmpDir, String(p.writeId), String(p.dataB64), { first: !!p.first, last: !!p.last, path: p.path ? String(p.path) : undefined, expectMtime: p.expectMtime == null ? undefined : Number(p.expectMtime) }); break;
            case "fs.downloadChunk": result = fsDownloadChunk(String(p.path), Number(p.offset), Number(p.len)); break;
            case "fs.archive": result = fsArchive(config.tmpDir, String(p.path)); break;
            case "git.log": result = gitLog(String(p.cwd), Number(p.limit ?? 30), p.query ? String(p.query) : undefined); break;
            case "git.branches": result = gitBranches(String(p.cwd)); break;
            case "git.status": result = gitStatus(String(p.cwd)); break;
            case "term.history": result = terminal.history(String(p.session)); break;
            case "term.paneInfo": result = terminal.paneInfo(String(p.session)); break;
            case "term.redraw": result = terminal.redraw(String(p.session)); break;
            case "terminal.pwd": result = terminal.pwd(String(p.session)); break;
            case "preview.mint": {
              // base is chosen by the client (project-root bookmark or the
              // file's dir). An authed device can already fs.read anything, so
              // scoping a token to any dir it names adds no new exposure.
              const dev = conn.remoteStatic ?? "unknown";
              result = { token: previewTokens.mint(String(p.base), dev, Date.now()) };
              break;
            }
            default:
              sendSecure(conn, { type: "response", id, ok: false, error: { code: "unknown_method", message: `unknown method: ${method}` } });
              return;
          }
          sendRpcResult(conn, id, result);
        } catch (e) {
          // Preserve a structured conflict tag so the client can key off the
          // code instead of pattern-matching the message text.
          const code = e instanceof Error && (e as Error & { code?: string }).code === "conflict" ? "conflict" : "rpc_error";
          sendSecure(conn, { type: "response", id, ok: false, error: { code, message: String(e) } });
        }
        break;
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
    handleClient(conn, text);
  };

  const onlineIpByPub = () => {
    const m = new Map<string, string>();
    for (const c of conns.values()) if (c.ready && c.remoteStatic) m.set(c.remoteStatic, c.ip);
    return m;
  };

  const handleAdmin = async (url: URL, req: Request): Promise<Response> => {
    if (url.pathname === "/admin") {
      return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/admin-api/devices") {
      return Response.json(deviceRows(config.registry.list(), onlineIpByPub()));
    }
    if (url.pathname === "/admin-api/pair" && req.method === "POST") {
      config.pairing = createPairing({ now: () => Date.now() });
      config.pairingMode = true;
      const pairString = buildPairingString(config.identity.publicKey, resolveAdvertise(config), config.pairing.code);
      config.audit.log({ event: "admin_pair_new" });
      return Response.json({ code: config.pairing.code, pairString });
    }
    if (url.pathname === "/admin-api/revoke" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { pubKey?: string };
      const pub = String(body.pubKey ?? "");
      if (envKeys.has(pub)) return new Response("env keys are read-only", { status: 400 });
      const removed = config.registry.remove(pub);
      if (removed) {
        config.audit.log({ event: "revoke", pub, ip: "admin" });
        for (const c of conns.values()) if (c.remoteStatic === pub) c.ws.close();
      }
      return Response.json({ ok: removed });
    }
    return new Response("Not found", { status: 404 });
  };

  const tlsMaterial = resolveTlsMaterial(config.keyDir, config.tls);
  const server = Bun.serve({
    hostname: config.listen.host,
    port: deps.port ?? config.listen.port,
    tls: tlsMaterial ?? undefined,
    async fetch(req, srv) {
      if (srv.upgrade(req)) return;
      const url = new URL(req.url);
      if (url.pathname.startsWith("/preview/")) {
        return buildPreviewResponse(previewTokens, url, Date.now());
      }
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/admin-api/")) {
        if (!config.adminEnabled) return new Response("Not found", { status: 404 });
        const ip = srv.requestIP(req)?.address ?? "";
        if (!isLocalAddr(ip)) return new Response("Forbidden", { status: 403 });
        return handleAdmin(url, req);
      }
      const r = resolveStatic(
        url.pathname,
        req.headers.get("accept") ?? "",
        assetKeys,
        req.headers.get("accept-encoding") ?? "",
      );
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
        }
        console.log("[pocketshell] disconnect");
      },
      message(ws, raw) { onMessage(ws, raw as any); },
      // Socket drained after backpressure: recover any dropped-output sessions.
      drain(ws) { const conn = conns.get(ws); if (conn) maybeResync(conn); },
    },
  });

  return {
    port: server.port,
    url: server.url,
    stop() {
      clearInterval(pushTimer);
      clearInterval(sweepTimer);
      clearInterval(previewSweepTimer);
      batcher.clearAll();
      terminal.dispose();
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
      config,
    },
  };
}

// Allow `bun run src/server.ts` (or the compiled binary) to boot directly.
if (import.meta.main) {
  if (process.argv.includes("--version")) {
    console.log(AGENT_VERSION);
    process.exit(0);
  }
  // `pocketshell-agent --warmup`: foreground TCC warmup, then exit. TCC
  // prompts from a launchd background process are not always reliable, so
  // running this once in a real terminal is the dependable fallback (and the
  // only way to batch the prompts ahead of first use). See warmup.ts.
  if (process.argv.includes("--warmup")) {
    const lines = runWarmup();
    for (const l of lines) console.log(l);
    if (lines.length === 0) console.log("[pocketshell] warmup done — no manual steps needed.");
    process.exit(0);
  }
  const cfg = loadConfig();
  ensureTmux(realTmuxDeps());
  const advertise = resolveAdvertise(cfg);
  const appUrl = advertiseToHttp(advertise);
  startServer({ config: cfg });
  const pairingString =
    cfg.pairingMode && cfg.pairing
      ? buildPairingString(cfg.identity.publicKey, advertise, cfg.pairing.code)
      : undefined;
  const lines = buildReadiness({
    advertise,
    appUrl,
    pubKeyB64: toB64(cfg.identity.publicKey),
    pairingString,
    pairingTtlSec: 300,
    advertiseExplicit: !!cfg.advertise,
    bindNonLocal: isNonLocalBind(cfg.listen.host),
  });
  console.log(`[pocketshell] listening on ${cfg.listen.host}:${cfg.listen.port} (TLS ${cfg.tls.enabled ? "on" : "off"})`);
  for (const l of lines) console.log(l);
  // macOS TCC warmup after boot: batch any permission prompts at startup.
  // Async + silent on failure; prints FDA guidance lines when FDA is missing.
  // Full no-op on non-darwin (see warmup.ts).
  setTimeout(() => {
    try { for (const l of runWarmup()) console.log(l); } catch { /* probes must never crash the agent */ }
  }, 0);
}
