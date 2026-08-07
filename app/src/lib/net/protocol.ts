// Mirror of agent/src/protocol.ts. Keep field names byte-for-byte identical.
export type SessionState = "run" | "wait" | "done" | "idle";
//  idle = 会话在 tmux 里存活，但本 Agent 未 attach（活动未知）

export interface SessionMeta {
  name: string;
  kind: "tmux" | "shell";
  state: SessionState;
  cols: number;
  rows: number;
  lastLine: string;
  createdAt: number;
  attached: boolean; // 本 Agent 是否已挂 PTY 纳管；外部会话为 false
  // AI 上下文用量（需求 5）。由工具自己的 hook / statusLine 在回合结束时
  // 推上来，没跑 AI 或还没跑完一轮时三者皆缺省 —— 分割条按「数据缺失即
  // 整块隐藏」处理，不显示占位符。
  ctxTool?: string;   // "claude" | "kimi" | "codex" | "opencode"
  ctxUsed?: number;   // 当前上下文已用 token
  ctxTotal?: number;  // 上下文窗口总量；claude 未接 statusLine 时缺省
}

export interface DeviceInfo {
  pubKey: string;
  name: string;
  addedAt: string;
  lastSeen: string | null;
  source: "registry" | "env";
  self: boolean;
}

export interface Snippet {
  id: string; group: string; label: string; command: string; autoEnter: boolean;
}

// 需求 5：输入联想条目。读取走 rpc `hints.list`（可被 rpcChunk 分片），
// 写操作走下面的专用消息，变更后广播无载荷的 `hintsChanged` 让各端重拉。
export interface Hint { id: string; text: string }

export type ClientMsg =
  | { type: "attach"; sessionId: string; lastSeq?: number }
  | { type: "detach"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  // cols/rows 可选：新建 tmux 会话时带上本机上次的可信尺寸，让会话**一开始就**按
  // 本机宽度排版。不带时 agent 退回 80x24，那之后由第一次 refit 纠正——但纠正之前
  // 上游程序（Claude Code）已经按 80 列打了硬换行进历史，而硬换行 tmux 反折不回来。
  | { type: "newSession"; name: string; cmd?: string; cwd?: string; kind?: "tmux" | "shell"; cols?: number; rows?: number }
  | { type: "kill"; sessionId: string }
  | { type: "listSessions" }
  | { type: "renameSession"; sessionId: string; name: string }
  | { type: "ping" }
  | { type: "presence"; foreground: boolean; activeSessionId: string | null }
  | { type: "pair"; code: string; deviceName: string }
  | { type: "listDevices" }
  | { type: "listSnippets" }
  | { type: "addSnippet"; group: string; label: string; command: string; autoEnter: boolean }
  | { type: "updateSnippet"; id: string; group: string; label: string; command: string; autoEnter: boolean }
  | { type: "removeSnippet"; id: string }
  | { type: "addHints"; texts: string[] }
  | { type: "updateHint"; id: string; text: string }
  | { type: "removeHint"; id: string }
  | { type: "clearHints" }
  | { type: "revokeDevice"; pubKey: string }
  // rpc methods mirror agent/src/protocol.ts: fs.* / git.* (log/branches/status/review) / term.* / terminal.pwd / preview.mint / update.check / update.apply / hints.list
  | { type: "rpc"; id: string; method: string; params?: unknown };

export type ServerMsg =
  | { type: "output"; sessionId: string; seq: number; data: string }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "exit"; sessionId: string; code: number }
  | { type: "error"; code: string; message: string }
  | { type: "pong" }
  | { type: "notification"; sessionId: string; title: string; body: string; ts: number }
  | { type: "resync"; sessionId: string; from: number }
  | { type: "paired"; ok: true }
  | { type: "devices"; devices: DeviceInfo[] }
  | { type: "snippets"; items: Snippet[] }
  // hints 变更通知（无载荷）：收到后各端自行 rpc("hints.list") 重拉。
  // 不像 snippets 那样带全量列表——联想库可达数百 KB，超过单个 Noise 消息
  // 的 65535 字节上限；rpc 响应则有 rpcChunk 分片兜底。
  | { type: "hintsChanged" }
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: { code: string; message: string } }
  | { type: "rpcChunk"; id: string; index: number; total: number; data: string }
  // OTA progress broadcast — one per phase transition during update.apply.
  // Purely additive; old clients ignore the unknown type. `pct` present only
  // during downloading when content-length is known.
  | { type: "update"; phase: "downloading" | "verifying" | "signing" | "applying" | "restarting" | "error"; pct?: number; message?: string; version?: string };

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}
export function decodeServer(raw: string): ServerMsg {
  return JSON.parse(raw) as ServerMsg;
}
export function decodeClient(raw: string): ClientMsg {
  return JSON.parse(raw) as ClientMsg;
}

// term.history 的 rpc 响应体。rpc 信封的 result 是 unknown，两端各自 cast 时
// 引用这个类型，避免字段名漂移。
//
// seq 是快照那一刻 replay 的 latestSeq：前端写完 data 后用 attach(seq) 只订阅
// 之后的增量，从而不重不丢地接上实时流。取号必须在 capture 之前（见
// terminal.ts 的 history 实现注释）。
export interface TermHistoryResult {
  data: string; // base64 的 capture-pane 原始字节（含 SGR）
  seq: number; // 快照时的 replay latestSeq；无输出记录时为 0
}

// term.capture 的 rpc 响应体。与 term.history 的区别是**给人看/给剪贴板**而不是
// 给 xterm 看：默认不带颜色（`-e` 关掉后 tmux 输出即纯文本，实测 3.6b 一个 SGR
// 都没有）。没有 seq——它不接管实时流，纯粹是一次性取文本。
//
// 请求参数：{ session: string; colors?: boolean; back?: number; endBack?: number }
//   back = 「从光标往上数几行开始取」。**是相对光标的距离，不是绝对行号**：
//   前端 xterm 的行坐标与 tmux 的可见区顶行不同源（实测同一 pane，xterm
//   cursorY=23 而 tmux cursor_y=3），传绝对行号会切错段。后端用 tmux 自己的
//   `#{cursor_y}` 把它解析成 `-S`。
//   endBack = 同一把尺子的另一端：区间在光标往上第几行**闭合**（含该行）。
//   不给就是 `-E -`（可见区底部，老调用方的行为）。两个都给即取
//   `back - endBack + 1` 行 —— 复制模式的「上翻加载更早 200 行」靠它，
//   否则每页都要把底部已经加载过的内容重传一遍。实测 tmux 3.6b 相邻区间
//   精确拼接（`-S -50 -E -41` 与 `-S -100 -E -91` 各 10 行、不重不漏）。
export interface TermCaptureResult {
  data: string; // base64 的 capture-pane 字节；colors 未开时为纯文本
  // 这一页之前**没有更早的内容**了。必须由后端算，前端两条显而易见的推断都
  // 是错的（均在 tmux 3.6b 实测）：`-J` 会把折行接成一行，所以「返回行数少于
  // 请求行数」不代表到顶；越过顶部 tmux 也不报错、不返回空，而是**钳位重发
  // 最老那一行**（hist=379 时 -S -900 与 -S -379 返回同一行），前端照着翻会
  // 无限追加重复内容。后端用 `#{history_size}` 定位最老一行来判定。
  atTop: boolean;
}

// git.review 的 rpc 响应体。三种审查范围（工作区 / 单个 commit / 分支相对基线）
// 共用同一个结构——它们在 git 层面本就是同一条 diff 换参数。
//
// 真相在 agent/src/git-review.ts；这里只是线协议声明，前端逐字镜像。
// base 可缺省：缺省时后端推断主干（origin/HEAD -> main -> master -> develop），
// 推断结果连同 inferred:true 一起回在 ReviewResult.baseline 里。都推不出就
// throw no_baseline，由 UI 弹分支列表请用户手选。
export type ReviewScope =
  | { kind: "worktree"; stage: "all" | "staged" | "unstaged" }
  | { kind: "commit"; hash: string }
  | { kind: "range"; base?: string };

export interface ReviewFile {
  path: string;
  status: "M" | "A" | "D" | "R" | "?";
  add: number;
  del: number;
  // 仅工作区范围有值。"full" = 已 add 且工作区无更多改动；"partial" = add 之后又改了。
  staged?: "full" | "partial";
  // 超单文件行数上限或总预算，服务端未传正文。UI 显示「内容过大，无法预览」。
  oversize?: true;
  binary?: true;
  // 未跟踪目录：只出一个条目，不展开（一个新建的 node_modules/ 会打爆预算）。
  isDir?: true;
  hunks?: { header: string; lines: { kind: "add" | "del" | "ctx"; text: string }[] }[];
}

export interface ReviewResult {
  scope: ReviewScope;
  // commit 范围下是 git 自己的 "%h %s"；工作区与分支范围为空串，
  // 由前端用 i18n 组装（后端塞中文会绕过 i18n 约束）。
  title: string;
  subtitle: string;
  files: ReviewFile[];
  totals: { files: number; add: number; del: number };
  truncated?: true;
  counts?: { all: number; staged: number; unstaged: number };
  baseline?: { base: string; inferred: boolean };
}
