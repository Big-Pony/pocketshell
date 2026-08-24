// Table-driven RPC routing, lifted verbatim out of server.ts's `case "rpc":`
// switch (which had grown to 34 methods of hand-written `String(p.xxx)`
// boilerplate behind a single `as any`).
//
// The wire behaviour is unchanged and must stay that way — this module is the
// same code, reorganised:
//   * every handler returns an RpcOutcome; `result` rides the caller's shared
//     send path (chunk-aware), `sent` means the handler already answered and
//     the caller must NOT send again. Four methods use `sent`:
//     notify.testWebhook / update.check / update.apply (all answer from an
//     async continuation) and the unknown-method fallback in dispatchRpc.
//   * parameter parsing lives in named pure functions (see `parse` below) so
//     it can be unit-tested without a server; the untyped-wire cast happens
//     once, in `asParams`.
import type { AgentConfig } from "./config";
import type { TerminalService } from "./terminal";
import type { ShellService } from "./shell-service";
import type { ReplayService } from "./replay";
import type { NotificationService } from "./notify-service";
import type { PreviewTokens } from "./preview-service";
import type { NotifyConfig } from "./notify-config";
import type { WireResult } from "./notify-wire";
import type { TermHistoryResult } from "./protocol";
import { fsTree, fsRead, fsDiff, fsOp, fsUploadCheck, fsResolveName, fsUploadChunk, fsDownloadChunk, fsArchive, fsWrite } from "./fs-service";
import { gitLog, gitBranches, gitStatus } from "./git-service";
import { gitReview, type ReviewScope } from "./git-review";
import { formatDiagReport } from "./diag-report";
import { diffScreens, hashLines, hashLinesBare } from "./screen-diff";
import { chainPathOf, wireStatusline, unwireStatusline } from "./statusline-wire";
import { checkLatest } from "./update-check";
import { importTheme } from "./server-theme";
import { readCache, writeCache, isFresh, CHECK_TTL_MS, type CachedCheck } from "./update-cache";
import { AGENT_VERSION } from "./version";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type NotifyTool = "claude" | "codex" | "opencode" | "kimi";
export type FsOpKind = "rename" | "delete" | "mkdir" | "touch";

/** Long-lived collaborators, built once per server. */
export interface RpcServices {
  config: AgentConfig;
  terminal: TerminalService;
  shell: ShellService;
  replay: ReplayService;
  notify: NotificationService;
  previewTokens: PreviewTokens;
  /** ~/.claude/settings.json — statusline (context.wire) writes here. */
  claudeSettingsPath: string;
  /** Absolute path of the running agent binary, embedded into hook configs. */
  agentBin: string;
  doWire(tool: NotifyTool, on: boolean): WireResult;
  runApply(): Promise<{ started: boolean; reason?: string }>;
}

/** Per-request state: who asked, and how to answer them. */
export interface RpcCall {
  id: string;
  /** Noise static pubkey of the calling device (null before/without one). */
  devicePub: string | null;
  /** Chunk-aware success reply (server.ts owns the framing). */
  sendResult(result: unknown): void;
  sendError(code: string, message: string): void;
  /** 含裸字节的成功回复（server.ts owns the framing，含单帧预算与分片回落）。 */
  sendBinary(meta: unknown, blob: Uint8Array): void;
}

export type RpcContext = RpcServices & RpcCall;

export type RpcOutcome =
  | { kind: "result"; result: unknown }
  /** The handler already answered; the caller must not send anything. */
  | { kind: "sent" }
  /**
   * 结果里含**裸字节**：meta 走 JSON 头，blob 走二进制帧尾。
   *
   * 用判别联合而不是「看返回值有没有 bytes 字段」猜：漏判的代价是静默数据
   * 损坏——JSON.stringify 会把 Uint8Array 序列化成 {"0":1,"1":2,…}（45KiB
   * 放大到 541930 字符），客户端拿到下标对象而非字节，Blob 出来的文件是坏的，
   * 全程无人报错。
   */
  | { kind: "binary"; meta: unknown; blob: Uint8Array };

export type RpcHandler = (ctx: RpcContext, p: RpcParams) => RpcOutcome | Promise<RpcOutcome>;

const ok = (result: unknown): RpcOutcome => ({ kind: "result", result });
const okBin = (meta: unknown, blob: Uint8Array): RpcOutcome => ({ kind: "binary", meta, blob });
const SENT: RpcOutcome = { kind: "sent" };

// 历史载荷压缩。终端文本的 SGR 转义码高度重复，实测 134KB → 33KB（gzip 1ms），
// 上链路 179KB → 44KB。与「只取最近 N 行」正交：两招叠加后 179KB → 12KB。
//
// 必须在这里做而不是在 WS 层开 perMessageDeflate —— 帧里装的是 Noise 密文，
// 密文不可压缩，那个开关对它完全无效。
//
// 压缩后反而更大时（极短的快照，gzip 头部开销）原样返回不带 enc ——
// 客户端按未压缩处理，两边都不需要特判。
export function compressHistory(h: TermHistoryResult): TermHistoryResult {
  if (!h.data) return h;
  try {
    const raw = Buffer.from(h.data, "base64");
    const gz = Buffer.from(Bun.gzipSync(raw));
    if (gz.byteLength >= raw.byteLength) return h;
    return { data: gz.toString("base64"), seq: h.seq, enc: "gzip" };
  } catch {
    // 压缩失败绝不能让重灌失败：原样回退。
    return h;
  }
}

// ---------------------------------------------------------------------------
// Parameter parsing
// ---------------------------------------------------------------------------

/** Wire params are attacker-controlled; this is the one place we cast. */
export type RpcParams = Record<string, unknown>;
export const asParams = (params: unknown): RpcParams => (params ?? {}) as RpcParams;

// Primitive readers. These reproduce the old inline coercions *exactly*:
//  - `str` is String(v), so a missing key yields the string "undefined";
//  - `optStr` keys off truthiness (not null-ness) like `p.cwd ? String(p.cwd) : undefined`;
//  - `optNum` keys off `== null` like `p.back == null ? undefined : Number(p.back)`.
export const str = (p: RpcParams, k: string): string => String(p[k]);
export const optStr = (p: RpcParams, k: string): string | undefined => (p[k] ? String(p[k]) : undefined);
export const num = (p: RpcParams, k: string): number => Number(p[k]);
export const optNum = (p: RpcParams, k: string): number | undefined => (p[k] == null ? undefined : Number(p[k]));
export const flag = (p: RpcParams, k: string): boolean => !!p[k];
export const strList = (p: RpcParams, k: string): string[] => (p[k] ?? []) as string[];

/**
 * 取二进制帧注入的 blob。缺席时抛 —— 这两个方法**必须**走二进制帧。
 *
 * 有意选择「抛」而不是回落到空字节：一个 JSON rpc 点名 fs.uploadChunk 却没带
 * blob，只可能是伪造或客户端 bug，静默写入 0 字节会悄悄损坏用户文件。
 * 抛出去会经 dispatchRpc 的 catch 变成一条明确的 rpc_error。
 *
 * （对照一阶段的行为：str(p,"dataB64") 在字段缺失时得到字符串 "undefined"，
 * Buffer.from("undefined","base64") 不抛异常、静默产出 6 个垃圾字节追加进
 * 用户文件——那才是真正危险的默认。）
 */
function blobOf(p: RpcParams): Uint8Array {
  const b = (p as Record<string, unknown>).__blob;
  if (!(b instanceof Uint8Array)) throw new Error("this method requires a binary frame");
  return b;
}

/** Per-method parsers — pure, exported, unit-testable without a server. */
export const parse = {
  path: (p: RpcParams) => ({ path: str(p, "path") }),
  session: (p: RpcParams) => ({ session: str(p, "session") }),
  cwd: (p: RpcParams) => ({ cwd: str(p, "cwd") }),
  fsDiff: (p: RpcParams) => ({ path: str(p, "path"), cwd: optStr(p, "cwd") }),
  fsOp: (p: RpcParams) => ({ op: p.op as FsOpKind, path: str(p, "path"), to: optStr(p, "to") }),
  fsUploadCheck: (p: RpcParams) => ({ dir: str(p, "dir"), names: strList(p, "names") }),
  fsResolveName: (p: RpcParams) => ({ dir: str(p, "dir"), name: str(p, "name") }),
  fsUploadChunk: (p: RpcParams) => ({
    uploadId: str(p, "uploadId"),
    bytes: blobOf(p),
    opts: { first: flag(p, "first"), last: flag(p, "last"), destPath: optStr(p, "destPath") },
  }),
  fsWrite: (p: RpcParams) => ({
    writeId: str(p, "writeId"),
    bytes: blobOf(p),
    opts: { first: flag(p, "first"), last: flag(p, "last"), path: optStr(p, "path"), expectMtime: optNum(p, "expectMtime") },
  }),
  fsDownloadChunk: (p: RpcParams) => ({ path: str(p, "path"), offset: num(p, "offset"), len: num(p, "len") }),
  gitLog: (p: RpcParams) => ({ cwd: str(p, "cwd"), limit: Number(p.limit ?? 30), query: optStr(p, "query") }),
  /**
   * scope 是联合类型，不能用 str()/num() 那套逐字段读。这里做判别式收窄：
   * 认不出的 kind 一律回落到 worktree/all 而不是 throw——老客户端或手工
   * 构造的请求不该让 agent 报错，回落到最安全的只读范围即可。
   */
  gitReview: (p: RpcParams) => {
    const raw = (p.scope ?? {}) as Record<string, unknown>;
    const kind = raw.kind;
    let scope: ReviewScope;
    if (kind === "commit") scope = { kind: "commit", hash: String(raw.hash) };
    // base 缺省是合法请求（让后端推断主干）。这里绝不能 String(undefined)
    // ——那会变成一个叫 "undefined" 的 revision，报 bad_revision 而不是推断。
    else if (kind === "range") {
      scope = typeof raw.base === "string" && raw.base
        ? { kind: "range", base: raw.base }
        : { kind: "range" };
    }
    else {
      const s = raw.stage;
      const stage = s === "staged" || s === "unstaged" ? s : "all";
      scope = { kind: "worktree", stage };
    }
    return { cwd: str(p, "cwd"), scope };
  },
  termHistory: (p: RpcParams) => ({ session: str(p, "session"), lines: optNum(p, "lines") }),
  /**
   * 屏幕对拍（见 screen-diff.ts）。hashes 是客户端 xterm 可视区的**逐行哈希**，
   * 不含任何字符。非数字项归 0 而不是抛——诊断路径永远不该因为脏输入而报错，
   * 顶多这一行比不出来。上限 512 行：真机 rows 最大值远小于它，超出必是异常。
   */
  diagScreen: (p: RpcParams) => ({
    session: str(p, "session"),
    why: optStr(p, "why") ?? "",
    // scope=scrollback 时比的是沉降历史，行数远多于一屏，512 的上限会把尾巴
    // 截掉 —— 而被截掉的行在集合比对里全都算「缺」，直接造出一批假阳。
    // 2048 与 scrollbackLines 的上限同阶。
    scope: optStr(p, "scope") === "scrollback" ? "scrollback" as const : "viewport" as const,
    lines: optNum(p, "lines"),
    hashes: Array.isArray(p.hashes)
      ? (p.hashes as unknown[]).slice(0, 2048).map((n) => (typeof n === "number" && Number.isFinite(n) ? n >>> 0 : 0))
      : [],
    // 同一批行的「两端空白全去」哈希。老客户端不发，为空即跳过第二次比对。
    hashesBare: Array.isArray(p.hashesBare)
      ? (p.hashesBare as unknown[]).slice(0, 2048).map((n) => (typeof n === "number" && Number.isFinite(n) ? n >>> 0 : 0))
      : [],
  }),
  termCapture: (p: RpcParams) => ({
    session: str(p, "session"),
    opts: { colors: flag(p, "colors"), back: optNum(p, "back"), endBack: optNum(p, "endBack") },
  }),
  previewMint: (p: RpcParams) => ({ base: str(p, "base") }),
  notifySetConfig: (p: RpcParams) => ({ config: p.config as NotifyConfig }),
  notifySubscribe: (p: RpcParams) => ({ subscription: p.subscription }),
  notifyWire: (p: RpcParams) => ({ tool: p.tool as NotifyTool }),
  notifyTestWebhook: (p: RpcParams) => ({ id: str(p, "id") }),
  updateCheck: (p: RpcParams) => ({ force: flag(p, "force") }),
  // Left as unknown-ish on purpose: importTheme() does the type narrowing, and
  // it has to anyway for the HTTP body. String(undefined) === "undefined" would
  // turn "you forgot the name" into "the name is literally undefined".
  themeImport: (p: RpcParams) => ({ name: p.name, text: p.text }),
  themeName: (p: RpcParams) => ({ name: str(p, "name") }),
};

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Preserve a structured conflict tag so the client can key off the code
 * instead of pattern-matching the message text.
 */
export function rpcErrorCode(e: unknown): "conflict" | "rpc_error" {
  return e instanceof Error && (e as Error & { code?: string }).code === "conflict" ? "conflict" : "rpc_error";
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const RPC_TABLE: Record<string, RpcHandler> = {
  "hints.list": (ctx) => ok({ items: ctx.config.hints.list().map((r) => ({ id: r.id, text: r.text })) }),

  "fs.tree": (_ctx, p) => ok(fsTree(parse.path(p).path)),
  "fs.read": (_ctx, p) => ok(fsRead(parse.path(p).path)),
  "fs.diff": (_ctx, p) => { const a = parse.fsDiff(p); return ok(fsDiff(a.path, a.cwd)); },
  "fs.op": (_ctx, p) => { const a = parse.fsOp(p); return ok(fsOp(a.op, a.path, a.to)); },
  "fs.uploadCheck": (_ctx, p) => { const a = parse.fsUploadCheck(p); return ok(fsUploadCheck(a.dir, a.names)); },
  "fs.resolveName": (_ctx, p) => { const a = parse.fsResolveName(p); return ok(fsResolveName(a.dir, a.name)); },
  "fs.uploadChunk": (ctx, p) => { const a = parse.fsUploadChunk(p); return ok(fsUploadChunk(ctx.config.tmpDir, a.uploadId, a.bytes, a.opts)); },
  "fs.write": (ctx, p) => { const a = parse.fsWrite(p); return ok(fsWrite(ctx.config.tmpDir, a.writeId, a.bytes, a.opts)); },
  "fs.downloadChunk": (_ctx, p) => {
    const a = parse.fsDownloadChunk(p);
    const r = fsDownloadChunk(a.path, a.offset, a.len);
    return okBin({ eof: r.eof, size: r.size }, r.bytes);
  },
  "fs.archive": (ctx, p) => ok(fsArchive(ctx.config.tmpDir, parse.path(p).path)),

  "git.log": (_ctx, p) => { const a = parse.gitLog(p); return ok(gitLog(a.cwd, a.limit, a.query)); },
  "git.branches": (_ctx, p) => ok(gitBranches(parse.cwd(p).cwd)),
  "git.status": (_ctx, p) => ok(gitStatus(parse.cwd(p).cwd)),
  "git.review": (_ctx, p) => { const a = parse.gitReview(p); return ok(gitReview(a.cwd, a.scope)); },

  // 先取号、后快照：capture 期间新到的输出必然拿到 > seq 的序号，
  // 前端 attach(seq) 会把它们补上。顺序反过来会丢字节。
  "term.history": async (ctx, p) => {
    const a = parse.termHistory(p);
    const seq = ctx.replay.latestSeq(a.session);
    if (ctx.shell.has(a.session)) return ok({ data: "", seq });
    return ok(compressHistory(await ctx.terminal.history(a.session, seq, a.lines)));
  },
  // 复制路径专用：默认纯文本（无 SGR），可给 back（光标往上第几行）
  // 只取某一轮命令的输出，再给 endBack 就是一个闭区间（复制模式上翻
  // 分页靠它，否则每页都要重传底部已有内容）。不取 seq —— 它不接管
  // 实时流。shell 会话没有 tmux pane，与 term.history 一样退化为空。
  "term.capture": async (ctx, p) => {
    const a = parse.termCapture(p);
    return ok(ctx.shell.has(a.session) ? { data: "", atTop: true } : await ctx.terminal.capture(a.session, a.opts));
  },
  /**
   * 屏幕对拍：把客户端 xterm 可视区的行哈希与 tmux 真值比一次，只把统计写进
   * agent 日志。**不返回内容、也不把内容写进日志**，见 screen-diff.ts 的隐私说明。
   *
   * 这是「内容中间少几行」故障的判定点：diffLines=0 ⇒ 数据在 buffer 里、是没画
   * 出来（查渲染器）；diffLines>0 ⇒ buffer 真的少了（查数据链路）。
   * shell 会话没有 tmux pane，退化为不比对。
   */
  "diag.screen": async (ctx, p) => {
    const a = parse.diagScreen(p);
    // 开关关闭时**整个跳过**，而不是只跳过日志：对拍要 spawn 两次 tmux
    // capture-pane，那才是这条埋点的主要成本。仍然返回 ok —— 客户端不该因为
    // 服务端关了诊断而收到 rpc 错误。
    if (!ctx.config.diag) return ok({ ok: true, skipped: "disabled" });
    if (ctx.shell.has(a.session)) return ok({ ok: true, skipped: "shell" });
    // scrollback 对拍（2026-08-24）：比的是**已沉降的历史**，不是当前屏。
    //
    // 为什么单独一条路径：视口对拍只看屏上那 27 行，而「往上翻才发现少了一段」
    // 的丢失全在 scrollback 里 —— 两边看的都不是出事的地方，于是一路报
    // missingLines=0。今天已经因为这个盲区两次把「没有证据」当成「没有问题」。
    //
    // 这里**不需要**两次确认与配对抵扣：沉降的历史不再变化，没有 spinner 噪音。
    // 集合比对天然不需要行号对齐（xterm 与 tmux 的 baseY 原点本来就不同）。
    if (a.scope === "scrollback") {
      const lines = a.lines ?? 300;
      const raw = await ctx.terminal.scrollbackLines(a.session, lines);
      const d = diffScreens(hashLines(raw), a.hashes);
      // 第二次比对：两端空白全去。它把「行真没了」与「行还在、缩进对不上」
      // 分开 —— 后者在集合比对里同样表现为 missing+extra 成对，光看第一组
      // 数字区分不了。老客户端不发 hashesBare，此时报 -1（读不到），别报 0
      // （那是「查了，没缺」，与「没查」是两回事）。
      const missingBare = a.hashesBare.length > 0
        ? diffScreens(hashLinesBare(raw), a.hashesBare).missingLines
        : -1;
      if (ctx.config.diag) {
        console.log(formatDiagReport({
          tag: a.session, kind: "screen", phase: "scrollback",
          tmuxLines: d.tmuxLines, xtermLines: d.xtermLines,
          missingLines: d.missingLines, extraLines: d.extraLines, firstDiff: d.firstDiff,
          missingAt: d.missingAt, missingBare,
        }));
      }
      return ok({ ok: true });
    }
    // 取两次 tmux，中间隔一小段：**只有在两次快照里都缺的行才算真缺**。
    //
    // 为什么必须这样（实测，不是设计洁癖）：客户端取哈希 → rpc 上行 → 这里
    // spawn tmux，中间隔一个 RTT（真机 1~3s）。Claude Code 界面里有 spinner
    // 动画、计时、token 计数**每帧都在变**，所以单次比对必然带一批假缺失
    // ——上线第一条真实数据就是 27 行里差 20 行，全是这种噪音。
    //
    // 两次都缺 ⇒ 这行在这段时间里持续不在客户端屏幕上 ⇒ 才是「内容丢了」。
    // 动画行在两次 tmux 快照之间自己就变了，第二次比对时对不上同一个哈希，
    // 自然被筛掉。
    const first = diffScreens(hashLines(await ctx.terminal.visibleLines(a.session)), a.hashes);
    await new Promise((r) => setTimeout(r, 250));
    const second = diffScreens(hashLines(await ctx.terminal.visibleLines(a.session)), a.hashes);
    // 取两次的**较小值**：任何一次不缺，就不算缺。
    const missingLines = Math.min(first.missingLines, second.missingLines);
    const extraLines = Math.min(first.extraLines, second.extraLines);
    // 动画行的指纹是 **missing 与 extra 成对**：同一行的两个版本（spinner 转了
    // 一帧、计时跳了一秒），tmux 侧算它缺、xterm 侧算它陈旧，两边各记一条。
    // 真丢内容不会在 xterm 侧凭空多出等量的行，所以成对的那部分要扣掉。
    // 实测线上样本：`缺=1 陈旧=1`、`缺=2 陈旧=2`、`缺=14 陈旧=15` 全是这一类。
    //
    // 扣的是**较小值**（配对数），剩下的才是净缺失。宁可少报也不多报：多报一次
    // 就要多查一轮，而这个 bug 已经在假信号上耗掉七轮了。
    const paired = Math.min(missingLines, extraLines);
    const d = {
      tmuxLines: second.tmuxLines,
      xtermLines: second.xtermLines,
      missingLines: missingLines - paired,
      extraLines: extraLines - paired,
      firstDiff: missingLines - paired > 0 ? second.firstDiff : -1,
    };
    console.log(formatDiagReport({ tag: a.session, kind: "screen", phase: a.why, ...d }));
    return ok({ ok: true, ...d });
  },

  "term.paneInfo": (ctx, p) => {
    const sid = parse.session(p).session;
    return ok(ctx.shell.has(sid) ? { currentCommand: "", alternateOn: false, isShell: true } : ctx.terminal.paneInfo(sid));
  },
  "term.redraw": (ctx, p) => {
    const sid = parse.session(p).session;
    return ok(ctx.shell.has(sid) ? { ok: true } : ctx.terminal.redraw(sid));
  },
  "terminal.pwd": (ctx, p) => {
    const sid = parse.session(p).session;
    return ok(ctx.shell.has(sid) ? { pwd: "" } : ctx.terminal.pwd(sid));
  },

  // base is chosen by the client (project-root bookmark or the file's dir). An
  // authed device can already fs.read anything, so scoping a token to any dir
  // it names adds no new exposure.
  "preview.mint": (ctx, p) => {
    const dev = ctx.devicePub ?? "unknown";
    return ok({ token: ctx.previewTokens.mint(parse.previewMint(p).base, dev, Date.now()) });
  },

  // 实例身份：只读，走通用 RPC 信封（不需要新增 protocol 消息类型）。
  // 天然只在 Noise 握手成功后可得 —— 未配对设备看不到实例名。
  "agent.info": (ctx) => ok({ instanceName: ctx.config.instanceName ?? null }),

  // 自定义主题的写操作。**读**走 HTTP（`GET /theme/custom.css`，必须是
  // <link> 能拉的普通样式表，见 server-theme.ts），写走这里——理由是鉴权：
  // 手机既不在 loopback 上、也拿不到 notify token，而 RPC 信封天然只有握手
  // 成功的设备能用，设备的 Noise 公钥就是凭据。同一台机器上的本地脚本仍可用
  // HTTP 的 POST /theme/import（loopback + bearer，照 /internal/notify）。
  //
  // 两者共用 importTheme()，所以「什么名字合法、什么文本能存」只有一份判定。
  "theme.import": (ctx, p) => ok(importTheme(ctx.config.themes, parse.themeImport(p))),
  // 删除只需要名字；store 自己会拒掉它本来就不会写的名字（不存在即 false，
  // 前端据此提示，而不是假装删成功）。
  "theme.remove": (ctx, p) => ok({ removed: ctx.config.themes.remove(parse.themeName(p).name) }),

  // 客户端诊断上报（docs/bug/终端显示异常2）。整屏文字消失只在真机回
  // 前台时偶现，而那正是「手边没有电脑、连不上 devtools」的场景，所以
  // 让 App 每次回前台把图集状态发回来，由 agent 打到 stdout —— launchd
  // 已把 stdout 落到 ~/Library/Logs/pocketshell/agent.out.log，用户零操作。
  // 内容经 formatDiagReport 白名单化：只留几个计数器，终端内容一律丢弃
  // （本仓库公开，日志有可能被贴进 issue）。
  // 开关关闭时静默丢弃：仍答 ok，老客户端（或本次会话开始前就在采样的客户端）
  // 不该因此拿到 rpc 错误。
  "diag.report": (ctx, p) => { if (ctx.config.diag) console.log(formatDiagReport(p)); return ok({ ok: true }); },

  "notify.getConfig": (ctx) => ok(ctx.notify.config()),
  "notify.setConfig": (ctx, p) => { ctx.notify.setConfig(parse.notifySetConfig(p).config); return ok({ ok: true }); },
  "notify.getVapidPublicKey": (ctx) => ok({ publicKey: ctx.notify.vapidPublicKey() }),
  "notify.subscribeWebPush": (ctx, p) => {
    // devicePub 为 null 时此前静默丢弃订阅却仍回 ok:true，前端会以为订阅成功、
    // 然后永远收不到推送且无从排查（14 期需求 4）。正常握手后它不该为 null，
    // 但静默失败通道必须堵上：抛出去由 dispatchRpc 转成 rpc_error。
    if (!ctx.devicePub) throw new Error("no_device_identity");
    ctx.notify.addSub(ctx.devicePub, parse.notifySubscribe(p).subscription);
    return ok({ ok: true });
  },
  "notify.unsubscribeWebPush": (ctx) => {
    if (ctx.devicePub) ctx.notify.removeSubsForDevice(ctx.devicePub);
    return ok({ ok: true });
  },
  "notify.wire": (ctx, p) => ok(ctx.doWire(parse.notifyWire(p).tool, true)),
  "notify.unwire": (ctx, p) => ok(ctx.doWire(parse.notifyWire(p).tool, false)),

  // 需求 5：接管 CC 的 statusLine 取上下文用量。与 notify.wire 分开
  // 是因为它不产生通知，只取数字；混进工具列表会让用户以为开了它
  // 就能收到推送。
  "context.wire": (ctx) => contextWire(ctx, true),
  "context.unwire": (ctx) => contextWire(ctx, false),

  // 诊断推送（14 期需求 4）。只发给**发起请求的这台设备**，不广播——
  // 测的是"我这台收不收得到"。返回的 ok 只表示推送服务受理了（HTTP 层），
  // 真正的送达判定由前端等 sw.js 的回报完成：生产实证 FCM 对已轮换的
  // endpoint 在宽限期内仍返回 201，只看状态码会报出错误的"一切正常"。
  "notify.testPush": async (ctx) => {
    if (!ctx.devicePub) throw new Error("no_device_identity");
    return ok(await ctx.notify.testPushTo(ctx.devicePub));
  },

  "notify.testWebhook": (ctx, p) => {
    // async self-answer, same pattern as update.check/update.apply below:
    // sends its own response and returns `sent` rather than handing a result
    // back to dispatchRpc's shared send path.
    void ctx.notify.testWebhook(parse.notifyTestWebhook(p).id).then(
      (r) => ctx.sendResult(r),
      (e) => ctx.sendError("rpc_error", String(e)),
    );
    return SENT;
  },

  "update.check": (ctx, p) => {
    // checkLatest() needs to await a network call. This handler sends its own
    // response from an async IIFE and returns `sent` immediately — mirroring
    // the unknown-method fallback in dispatchRpc, which likewise bypasses the
    // shared send path. (The dispatcher is async since term.history moved to
    // tmuxAsync, so the IIFE is no longer strictly required here; it is kept
    // because returning early also skips the shared send path.)
    const force = parse.updateCheck(p).force;
    void (async () => {
      try {
        const cached = readCache(ctx.config.keyDir);
        let out: CachedCheck;
        if (!force && isFresh(cached, Date.now(), CHECK_TTL_MS)) {
          out = cached as CachedCheck;
        } else {
          const r = await checkLatest({ repo: ctx.config.update?.repo ?? null, current: AGENT_VERSION });
          out = { ...r, checkedAt: Date.now() };
          writeCache(ctx.config.keyDir, out);
        }
        ctx.sendResult(out);
      } catch (e) {
        ctx.sendError(rpcErrorCode(e), String(e));
      }
    })();
    return SENT;
  },

  "update.apply": (ctx) => {
    // runApply is async (readCache/applyGate resolve synchronously, but it's
    // declared async so the caller always awaits a Promise) — mirrors the
    // update.check handler above: it sends its own response and returns
    // `sent` rather than handing a result back to the shared send path.
    void ctx.runApply().then(
      (out) => ctx.sendResult(out),
      (e) => ctx.sendError("rpc_error", String(e)),
    );
    return SENT;
  },
};

// chain 路径与 statusline 子命令的读取端同源（chainPathOf），
// 两边各写各的会导致解除接线时还原不回用户原来的状态栏。
function contextWire(ctx: RpcContext, on: boolean): RpcOutcome {
  const chainPath = chainPathOf(process.env);
  const r = on
    ? wireStatusline(ctx.claudeSettingsPath, chainPath, ctx.agentBin)
    : unwireStatusline(ctx.claudeSettingsPath, chainPath, ctx.agentBin);
  if (r.ok) { const c = ctx.notify.config(); c.contextStatusline = on; ctx.notify.setConfig(c); }
  return ok(r);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const isThenable = (v: unknown): v is Promise<RpcOutcome> =>
  typeof (v as { then?: unknown } | null)?.then === "function";

/** Own-property lookup only: an inherited key like "toString" is NOT a method. */
export function lookupRpc(method: string): RpcHandler | undefined {
  return Object.hasOwn(RPC_TABLE, method) ? RPC_TABLE[method] : undefined;
}

/**
 * Route one `rpc` message. Answers on every path: a table hit either yields a
 * result (sent via ctx.sendResult) or answered itself; a miss replies
 * unknown_method; a throw/rejection replies conflict|rpc_error.
 *
 * Deliberately NOT `async`: a synchronous handler must reach sendResult in the
 * caller's own tick (the old switch did, and both the wire tests and the
 * in-process __test hooks read the reply right after message()). Only the two
 * genuinely async handlers (term.history / term.capture) return a promise.
 */
export function dispatchRpc(ctx: RpcContext, method: string, params: unknown): void | Promise<void> {
  try {
    const handler = lookupRpc(method);
    if (!handler) {
      ctx.sendError("unknown_method", `unknown method: ${method}`);
      return;
    }
    const outcome = handler(ctx, asParams(params));
    if (isThenable(outcome)) {
      // .then(ok).catch(err) — not .then(ok, err) — so a throw from the send
      // path lands in the same error reply the old inline try/catch produced.
      return outcome
        .then((o) => {
          if (o.kind === "result") ctx.sendResult(o.result);
          else if (o.kind === "binary") ctx.sendBinary(o.meta, o.blob);
        })
        .catch((e) => { ctx.sendError(rpcErrorCode(e), String(e)); });
    }
    if (outcome.kind === "result") ctx.sendResult(outcome.result);
    else if (outcome.kind === "binary") ctx.sendBinary(outcome.meta, outcome.blob);
  } catch (e) {
    ctx.sendError(rpcErrorCode(e), String(e));
  }
}
