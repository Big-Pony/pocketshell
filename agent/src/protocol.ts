// Wire protocol — authoritative subset for slice 1. Mirrors A3 §3.
// `data` fields carry base64-encoded bytes (see bytes.ts). All frames are JSON
// text; switching output to binary WS frames is a later-slice optimization.

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

export type ClientMsg =
  | { type: "attach"; sessionId: string; lastSeq?: number }
  // detach: unsubscribe from a session's output (fire-and-forget, no response).
  // Purely additive — old clients never send it and degrade to subscribe-only.
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
  | { type: "removeSnippet"; id: string }
  | { type: "revokeDevice"; pubKey: string }
  // rpc methods: fs.* / git.* / term.* / terminal.pwd / preview.mint / update.check / update.apply
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
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: { code: string; message: string } }
  // rpcChunk: one shard of an oversize rpc success response (WP-6). `data` is
  // base64 of a byte slice of the full `response` message's UTF-8 JSON; shards
  // of one id go out in index order and the client reassembles the original
  // response from the concatenated bytes. Purely additive — an old client would
  // reject the unknown type, but app and agent ship as one versioned bundle
  // (the agent serves the app), so there is no version-skew surface.
  | { type: "rpcChunk"; id: string; index: number; total: number; data: string }
  // OTA progress broadcast — one per phase transition during update.apply.
  // Purely additive; old clients ignore the unknown type. `pct` present only
  // during downloading when content-length is known.
  | { type: "update"; phase: "downloading" | "verifying" | "signing" | "applying" | "restarting" | "error"; pct?: number; message?: string; version?: string };

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: string): ClientMsg {
  return JSON.parse(raw) as ClientMsg;
}

export function decodeServer(raw: string): ServerMsg {
  return JSON.parse(raw) as ServerMsg;
}
