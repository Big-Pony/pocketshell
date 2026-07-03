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

export type ConnStatus = "connecting" | "online" | "offline";

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  now(): number;
}

const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
  clearInterval: (id) => clearInterval(id),
  now: () => Date.now(),
};

export interface ConnectionOpts {
  url: string;
  wsFactory?: (url: string) => WebSocketLike;
  scheduler?: Scheduler;
  heartbeatMs?: number;
  livenessMs?: number;
}

type OutputCb = (f: { sessionId: string; seq: number; data: Uint8Array }) => void;
type SessionsCb = (sessions: SessionMeta[]) => void;
type ExitCb = (f: { sessionId: string; code: number }) => void;
type ErrorCb = (f: { code: string; message: string }) => void;
type ResyncCb = (f: { sessionId: string; from: number }) => void;

export class Connection {
  private ws!: WebSocketLike;
  private open = false;
  private queue: string[] = [];
  private outputCbs: OutputCb[] = [];
  private sessionsCbs: SessionsCb[] = [];
  private exitCbs: ExitCb[] = [];
  private errorCbs: ErrorCb[] = [];
  private resyncCbs: ResyncCb[] = [];
  private attached = new Set<string>();
  private seen = new Map<string, number>();

  private sched: Scheduler;
  private statusCbs: ((s: ConnStatus) => void)[] = [];
  private _status: ConnStatus = "connecting";

  private url: string;
  private factory: (url: string) => WebSocketLike;
  private backoffAttempt = 0;
  private reconnectTimer?: number;
  private heartbeatMs: number;
  private livenessMs: number;

  get status(): ConnStatus { return this._status; }

  onStatus(cb: (s: ConnStatus) => void): () => void {
    this.statusCbs.push(cb);
    return () => { this.statusCbs = this.statusCbs.filter((c) => c !== cb); };
  }

  private setStatus(s: ConnStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const cb of this.statusCbs) cb(s);
  }

  dispose(): void { this.ws.close(); }

  constructor(opts: ConnectionOpts) {
    this.factory = opts.wsFactory ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
    this.url = opts.url;
    this.sched = opts.scheduler ?? realScheduler;
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;  // reserved for Task 8
    this.livenessMs = opts.livenessMs ?? 25_000;    // reserved for Task 8
    this.connect();
  }

  private connect(): void {
    const socket = this.factory(this.url);
    this.ws = socket;
    this.open = false;
    this.setStatus("connecting");
    socket.onopen = () => {
      if (socket !== this.ws) return;
      this.open = true;
      this.backoffAttempt = 0;
      const pending = this.queue;
      this.queue = [];
      for (const raw of pending) socket.send(raw);
      // on reconnect: re-attach all attached sessions with their seen seq + send listSessions
      if (this.attached.size > 0) {
        for (const id of this.attached) {
          socket.send(encode({ type: "attach", sessionId: id, lastSeq: this.seen.get(id) ?? 0 }));
        }
        socket.send(encode({ type: "listSessions" }));
      }
      this.setStatus("online");
    };
    socket.onmessage = (ev) => {
      if (socket !== this.ws) return;
      this.dispatch(ev.data);
    };
    socket.onclose = () => {
      if (socket !== this.ws) return;
      this.handleDown();
    };
  }

  private handleDown(): void {
    this.open = false;
    this.setStatus("offline");
    const delay = Math.min(10_000, 500 * 2 ** this.backoffAttempt);
    this.backoffAttempt++;
    this.reconnectTimer = this.sched.setTimeout(() => this.connect(), delay);
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
      const prev = this.seen.get(msg.sessionId) ?? 0;
      if (msg.seq > prev) this.seen.set(msg.sessionId, msg.seq);
      const f = { sessionId: msg.sessionId, seq: msg.seq, data: fromB64(msg.data) };
      for (const cb of this.outputCbs) cb(f);
    } else if (msg.type === "resync") {
      for (const cb of this.resyncCbs) cb({ sessionId: msg.sessionId, from: msg.from });
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
    this.attached.add(sessionId);
    const seq = this.seen.get(sessionId) ?? lastSeq ?? 0;
    this.send({ type: "attach", sessionId, lastSeq: seq });
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
  onResync(cb: ResyncCb): () => void {
    this.resyncCbs.push(cb);
    return () => { this.resyncCbs = this.resyncCbs.filter((c) => c !== cb); };
  }
  detach(sessionId: string): void {
    this.attached.delete(sessionId);
    this.seen.delete(sessionId);
  }
}
