// B1 (slice-1, plaintext): the app's single network entry point. WS connect,
// encode/decode, dispatch. Noise handshake, reconnect state machine, secure
// storage, pairing, and rpc() are added in later slices.
import { encode, decodeServer, type ClientMsg, type SessionMeta } from "./protocol";
import { toB64, fromB64 } from "./bytes";

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ConnectionOpts {
  url: string;
  wsFactory?: (url: string) => WebSocketLike;
}

type OutputCb = (f: { sessionId: string; seq: number; data: Uint8Array }) => void;
type SessionsCb = (sessions: SessionMeta[]) => void;
type ExitCb = (f: { sessionId: string; code: number }) => void;
type ErrorCb = (f: { code: string; message: string }) => void;

export class Connection {
  private ws: WebSocketLike;
  private open = false;
  private queue: string[] = [];
  private outputCbs: OutputCb[] = [];
  private sessionsCbs: SessionsCb[] = [];
  private exitCbs: ExitCb[] = [];
  private errorCbs: ErrorCb[] = [];

  constructor(opts: ConnectionOpts) {
    const factory = opts.wsFactory ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
    this.ws = factory(opts.url);
    this.ws.onopen = () => {
      const pending = this.queue;
      this.queue = [];
      for (const raw of pending) this.ws.send(raw);
      this.open = true;
    };
    this.ws.onmessage = (ev) => this.dispatch(ev.data);
    this.ws.onclose = () => {
      this.open = false;
    };
  }

  private dispatch(raw: string): void {
    let msg;
    try {
      msg = decodeServer(raw);
    } catch (e) {
      console.error("[Connection] dropped malformed frame", e);
      return;
    }
    if (msg.type === "output") {
      const f = { sessionId: msg.sessionId, seq: msg.seq, data: fromB64(msg.data) };
      for (const cb of this.outputCbs) cb(f);
    } else if (msg.type === "sessions") {
      for (const cb of this.sessionsCbs) cb(msg.sessions);
    } else if (msg.type === "exit") {
      for (const cb of this.exitCbs) cb({ sessionId: msg.sessionId, code: msg.code });
    } else if (msg.type === "error") {
      for (const cb of this.errorCbs) cb({ code: msg.code, message: msg.message });
    }
  }

  private send(msg: ClientMsg): void {
    const raw = encode(msg);
    if (this.open) this.ws.send(raw);
    else this.queue.push(raw);
  }

  newSession(name: string, opt: { cmd?: string; cwd?: string } = {}): void {
    this.send({ type: "newSession", name, cmd: opt.cmd, cwd: opt.cwd });
  }
  attach(sessionId: string, lastSeq?: number): void {
    this.send({ type: "attach", sessionId, lastSeq });
  }
  sendInput(sessionId: string, data: Uint8Array): void {
    this.send({ type: "input", sessionId, data: toB64(data) });
  }
  resize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: "resize", sessionId, cols, rows });
  }
  kill(sessionId: string): void {
    this.send({ type: "kill", sessionId });
  }
  listSessions(): void {
    this.send({ type: "listSessions" });
  }
  renameSession(sessionId: string, name: string): void {
    this.send({ type: "renameSession", sessionId, name });
  }
  onOutput(cb: OutputCb): () => void {
    this.outputCbs.push(cb);
    return () => {
      this.outputCbs = this.outputCbs.filter((c) => c !== cb);
    };
  }
  onSessions(cb: SessionsCb): () => void {
    this.sessionsCbs.push(cb);
    return () => { this.sessionsCbs = this.sessionsCbs.filter((c) => c !== cb); };
  }
  onExit(cb: ExitCb): () => void {
    this.exitCbs.push(cb);
    return () => { this.exitCbs = this.exitCbs.filter((c) => c !== cb); };
  }
  onError(cb: ErrorCb): () => void {
    this.errorCbs.push(cb);
    return () => { this.errorCbs = this.errorCbs.filter((c) => c !== cb); };
  }
}
