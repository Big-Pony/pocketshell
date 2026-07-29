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
  | { type: "newSession"; name: string; cmd?: string; cwd?: string; kind?: "tmux" | "shell" }
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
  // rpc methods mirror agent/src/protocol.ts: fs.* / git.* / term.* / terminal.pwd / preview.mint / update.check / update.apply / hints.list
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
// 都没有），可选 `start` 指定起始行（复制某一轮命令的输出）。没有 seq——它不接管
// 实时流，纯粹是一次性取文本。
//
// 请求参数：{ session: string; colors?: boolean; start?: number }
export interface TermCaptureResult {
  data: string; // base64 的 capture-pane 字节；colors 未开时为纯文本
}
