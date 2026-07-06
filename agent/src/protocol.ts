// Wire protocol — authoritative subset for slice 1. Mirrors A3 §3.
// `data` fields carry base64-encoded bytes (see bytes.ts). All frames are JSON
// text; switching output to binary WS frames is a later-slice optimization.

export type SessionState = "run" | "wait" | "done" | "idle";
//  idle = 会话在 tmux 里存活，但本 Agent 未 attach（活动未知）

export interface SessionMeta {
  name: string;
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
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "newSession"; name: string; cmd?: string; cwd?: string }
  | { type: "kill"; sessionId: string }
  | { type: "listSessions" }
  | { type: "renameSession"; sessionId: string; name: string }
  | { type: "ping" }
  | { type: "pair"; code: string; deviceName: string }
  | { type: "listDevices" }
  | { type: "listSnippets" }
  | { type: "addSnippet"; group: string; label: string; command: string; autoEnter: boolean }
  | { type: "removeSnippet"; id: string }
  | { type: "revokeDevice"; pubKey: string }
  | { type: "rpc"; id: string; method: string; params?: unknown };

export type ServerMsg =
  | { type: "output"; sessionId: string; seq: number; data: string }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "exit"; sessionId: string; code: number }
  | { type: "error"; code: string; message: string }
  | { type: "pong" }
  | { type: "resync"; sessionId: string; from: number }
  | { type: "paired"; ok: true }
  | { type: "devices"; devices: DeviceInfo[] }
  | { type: "snippets"; items: Snippet[] }
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: { code: string; message: string } };

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: string): ClientMsg {
  return JSON.parse(raw) as ClientMsg;
}

export function decodeServer(raw: string): ServerMsg {
  return JSON.parse(raw) as ServerMsg;
}
