// Mirror of agent/src/protocol.ts. Keep field names byte-for-byte identical.
export type SessionState = "run" | "wait" | "done";

export interface SessionMeta {
  name: string;
  state: SessionState;
  cols: number;
  rows: number;
  lastLine: string;
  createdAt: number;
}

export type ClientMsg =
  | { type: "attach"; sessionId: string; lastSeq?: number }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "newSession"; name: string; cmd?: string; cwd?: string }
  | { type: "kill"; sessionId: string }
  | { type: "listSessions" }
  | { type: "renameSession"; sessionId: string; name: string };

export type ServerMsg =
  | { type: "output"; sessionId: string; seq: number; data: string }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "exit"; sessionId: string; code: number }
  | { type: "error"; code: string; message: string };

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}
export function decodeServer(raw: string): ServerMsg {
  return JSON.parse(raw) as ServerMsg;
}
export function decodeClient(raw: string): ClientMsg {
  return JSON.parse(raw) as ClientMsg;
}
