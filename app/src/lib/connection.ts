// B1 (slice-1, plaintext): the app's single network entry point. WS connect,
// encode/decode, dispatch. Noise handshake, reconnect state machine, secure
// storage, pairing, and rpc() are added in later slices.
import { encode, decodeServer, type ClientMsg } from "./protocol";
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

export class Connection {
  private ws: WebSocketLike;
  private open = false;
  private queue: string[] = [];
  private outputCbs: OutputCb[] = [];

  constructor(opts: ConnectionOpts) {
    const factory = opts.wsFactory ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
    this.ws = factory(opts.url);
    this.ws.onopen = () => {
      this.open = true;
      for (const raw of this.queue) this.ws.send(raw);
      this.queue = [];
    };
    this.ws.onmessage = (ev) => this.dispatch(ev.data);
    this.ws.onclose = () => {
      this.open = false;
    };
  }

  private dispatch(raw: string): void {
    const msg = decodeServer(raw);
    if (msg.type === "output") {
      const f = { sessionId: msg.sessionId, seq: msg.seq, data: fromB64(msg.data) };
      for (const cb of this.outputCbs) cb(f);
    }
    // sessions/exit/error handled in later slices.
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
  onOutput(cb: OutputCb): void {
    this.outputCbs.push(cb);
  }
}
