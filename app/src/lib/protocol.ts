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
