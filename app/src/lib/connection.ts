// B1 (slice-1, plaintext): the app's single network entry point. WS connect,
// encode/decode, dispatch. Noise handshake, reconnect state machine, secure
// storage, pairing, and rpc() are added in later slices.
// S4b: in-channel pairing — send pair on established, await paired, then normal flow.
import { encode, decodeServer, type ClientMsg, type SessionMeta, type DeviceInfo, type Snippet } from "./protocol";
import { toB64, fromB64 } from "./bytes";
import { ChunkReassembler } from "./rpc-chunks";
import { createInitiatorChannel, type SecureChannel } from "./secure-channel";
import { loadOrCreateIdentity, getAgentPubKey, getPendingPair, clearPendingPair } from "./keystore";
import { tr } from "./i18n";

export interface WebSocketLike {
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null;
  onclose: (() => void) | null;
  send(data: Uint8Array): void;
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
  // A9: random source for the reconnect-backoff jitter (tests inject a fixed
  // value to pin the delay at an exact bound).
  random?: () => number;
  heartbeatMs?: number;
  livenessMs?: number;
  channelFactory?: () => SecureChannel;
  handshakeTimeoutMs?: number;
  getPairing?: () => { code: string; deviceName: string } | null;
  onPaired?: () => void;
}

type OutputCb = (f: { sessionId: string; seq: number; data: Uint8Array }) => void;
type SessionsCb = (sessions: SessionMeta[]) => void;
type ExitCb = (f: { sessionId: string; code: number }) => void;
type ErrorCb = (f: { code: string; message: string }) => void;
type ResyncCb = (f: { sessionId: string; from: number }) => void;
type InputCb = (sessionId: string) => void;
type UpdateCb = (u: { phase: string; pct?: number; message?: string; version?: string }) => void;
type NotificationCb = (m: { sessionId: string; title: string; body: string; ts: number }) => void;

export class Connection {
  private ws!: WebSocketLike;
  private open = false;
  private queue: string[] = [];
  private outputCbs: OutputCb[] = [];
  private inputCbs: InputCb[] = [];
  private sessionsCbs: SessionsCb[] = [];
  private exitCbs: ExitCb[] = [];
  private errorCbs: ErrorCb[] = [];
  private resyncCbs: ResyncCb[] = [];
  private attached = new Set<string>();
  private seen = new Map<string, number>();
  private pairing = false;
  private devicesCbs: ((d: DeviceInfo[]) => void)[] = [];
  private snippetsCbs: ((s: Snippet[]) => void)[] = [];
  private updateCbs: UpdateCb[] = [];
  private notificationCbs: NotificationCb[] = [];
  private establishedThisSocket = false;
  private pairFailStreak = 0;
  private rpcSeq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  // WP-6: rpcChunk reassembly buffers share the pending rpc's exact lifetime —
  // dropped on settle/timeout, cleared on disconnect.
  private chunks = new ChunkReassembler();

  private sched: Scheduler;
  private statusCbs: ((s: ConnStatus) => void)[] = [];
  private _status: ConnStatus = "connecting";

  private url: string;
  private factory: (url: string) => WebSocketLike;
  private rand: () => number;
  private backoffAttempt = 0;
  private reconnectTimer?: number;
  private heartbeatMs: number;
  private livenessMs: number;
  private hbTimer?: number;
  private lastRx = 0;

  private channel!: SecureChannel;
  private makeChannel: () => SecureChannel;
  private handshakeTimeoutMs: number;
  private hsTimer?: number;
  private getPairing: () => { code: string; deviceName: string } | null;
  private onPaired?: () => void;

  get status(): ConnStatus { return this._status; }
  /** The agent WebSocket URL this connection targets (for deriving the preview HTTP origin). */
  get agentUrl(): string { return this.url; }

  onStatus(cb: (s: ConnStatus) => void): () => void {
    this.statusCbs.push(cb);
    return () => { this.statusCbs = this.statusCbs.filter((c) => c !== cb); };
  }

  private setStatus(s: ConnStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const cb of this.statusCbs) cb(s);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastRx = this.sched.now();
    this.hbTimer = this.sched.setInterval(() => {
      if (this.sched.now() - this.lastRx > this.livenessMs) {
        this.stopHeartbeat();
        this.ws.close();
        return;
      }
      if (this.open && this.channel.state === "transport") {
        this.ws.send(this.channel.send(new Uint8Array(new TextEncoder().encode(encode({ type: "ping" })))));
      }
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.hbTimer !== undefined) {
      this.sched.clearInterval(this.hbTimer);
      this.hbTimer = undefined;
    }
  }

  private clearHsTimer(): void {
    if (this.hsTimer !== undefined) { this.sched.clearTimeout(this.hsTimer); this.hsTimer = undefined; }
  }

  dispose(): void {
    this.stopHeartbeat();
    this.clearHsTimer();
    if (this.reconnectTimer !== undefined) this.sched.clearTimeout(this.reconnectTimer);
    this.rejectAllPending();
    this.ws.close();
  }

  rpc(method: string, params?: unknown): Promise<unknown> {
    const id = String(++this.rpcSeq);
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.sched.setTimeout(() => {
        this.pending.delete(id);
        this.chunks.drop(id);
        const e = new Error("rpc_timeout") as Error & { code?: string };
        e.code = "rpc_timeout";
        reject(e);
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: "rpc", id, method, params });
    });
  }

  private rejectAllPending(): void {
    for (const [, p] of this.pending) {
      this.sched.clearTimeout(p.timer);
      const e = new Error("disconnected") as Error & { code?: string };
      e.code = "disconnected";
      p.reject(e);
    }
    this.pending.clear();
    this.chunks.clear();
  }

  constructor(opts: ConnectionOpts) {
    this.factory = opts.wsFactory ?? ((u) => {
      const ws = new WebSocket(u) as unknown as WebSocketLike;
      ws.binaryType = "arraybuffer";
      return ws;
    });
    this.url = opts.url;
    this.sched = opts.scheduler ?? realScheduler;
    this.rand = opts.random ?? Math.random;
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
    this.livenessMs = opts.livenessMs ?? 25_000;
    this.makeChannel = opts.channelFactory ?? (() => {
      const agentPub = getAgentPubKey();
      if (!agentPub) throw new Error("agent public key not configured");
      return createInitiatorChannel({ identity: loadOrCreateIdentity(), agentPublicKey: agentPub });
    });
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5000;
    this.getPairing = opts.getPairing ?? (() => getPendingPair());
    this.onPaired = opts.onPaired;
    this.connect();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && this._status === "offline") {
          if (this.reconnectTimer !== undefined) { this.sched.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
          this.backoffAttempt = 0;
          this.connect();
        }
      });
    }
  }

  private connect(): void {
    const socket = this.factory(this.url);
    this.ws = socket;
    this.open = false;
    this.establishedThisSocket = false;
    this.setStatus("connecting");
    socket.onopen = () => {
      if (socket !== this.ws) return;
      try {
        this.channel = this.makeChannel();
        const m1 = this.channel.start();
        if (m1) socket.send(m1);
      } catch (e) {
        console.warn("[Connection] channel init failed:", e);
        this.handleDown();
        return;
      }
      this.hsTimer = this.sched.setTimeout(() => {
        this.clearHsTimer();
        this.ws.close();
      }, this.handshakeTimeoutMs);
    };
    socket.onmessage = (ev) => {
      if (socket !== this.ws) return;
      this.lastRx = this.sched.now();
      const bytes = new Uint8Array(ev.data);
      const r = this.channel.receive(bytes);
      if (r.status === "fail") { this.clearHsTimer(); this.ws.close(); return; }
      if (r.status === "handshake") {
        if (r.reply) socket.send(r.reply);
        if (r.established) { this.clearHsTimer(); this.onEstablished(socket); }
        return;
      }
      this.dispatch(new TextDecoder().decode(r.plaintext));
    };
    socket.onclose = () => {
      if (socket !== this.ws) return;
      this.handleDown();
    };
  }

  private flushAndRestore(socket: WebSocketLike): void {
    const pending = this.queue; this.queue = [];
    for (const raw of pending) socket.send(this.channel.send(new Uint8Array(new TextEncoder().encode(raw))));
    for (const id of this.attached) {
      socket.send(this.channel.send(new Uint8Array(new TextEncoder().encode(encode({ type: "attach", sessionId: id, lastSeq: this.seen.get(id) ?? 0 })))));
    }
    socket.send(this.channel.send(new Uint8Array(new TextEncoder().encode(encode({ type: "listSessions" })))));
  }

  private onEstablished(socket: WebSocketLike): void {
    this.open = true;
    this.establishedThisSocket = true;
    this.pairFailStreak = 0;
    this.backoffAttempt = 0;
    this.startHeartbeat();
    const pair = this.getPairing();
    if (pair) {
      this.pairing = true;
      socket.send(this.channel.send(new Uint8Array(new TextEncoder().encode(encode({ type: "pair", code: pair.code, deviceName: pair.deviceName })))));
      this.setStatus("connecting"); // stay connecting until paired
      return;
    }
    this.flushAndRestore(socket);
    this.setStatus("online");
  }

  private handleDown(): void {
    this.clearHsTimer();
    this.stopHeartbeat();
    this.rejectAllPending();
    this.open = false;
    this.pairing = false;
    // A pairing attempt that keeps closing before the handshake completes is
    // being rejected by the agent (closed pairing window / wrong agent key) —
    // the agent rejects at the handshake with no pair_failed message, so this
    // is the only signal. Tolerate a transient blip, but after a few dead
    // attempts drop the code so we stop looping (and self-tripping the limiter).
    if (this.getPairing() && !this.establishedThisSocket) {
      if (++this.pairFailStreak >= 3) {
        clearPendingPair();
        this.pairFailStreak = 0;
        for (const cb of this.errorCbs) cb({ code: "pair_failed", message: tr("errors.pairRejected") });
      }
    } else {
      this.pairFailStreak = 0;
    }
    this.setStatus("offline");
    // A9: ±20% jitter on the exponential backoff so a fleet of devices that
    // lost the connection together (agent restart, network flap) does not
    // reconnect in lock-step and spike the server.
    const delay = Math.round(Math.min(10_000, 500 * 2 ** this.backoffAttempt) * (0.8 + 0.4 * this.rand()));
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
    } else if (msg.type === "paired") {
      this.pairing = false;
      clearPendingPair();
      this.onPaired?.();
      this.flushAndRestore(this.ws);
      this.setStatus("online");
    } else if (msg.type === "devices") {
      for (const cb of this.devicesCbs) cb(msg.devices);
    } else if (msg.type === "snippets") {
      for (const cb of this.snippetsCbs) cb(msg.items);
    } else if (msg.type === "response") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        this.chunks.drop(msg.id); // defensive: single frame after partial chunks
        this.sched.clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else { const e = new Error(msg.error.message) as Error & { code?: string }; e.code = msg.error.code; p.reject(e); }
      }
    } else if (msg.type === "rpcChunk") {
      this.handleRpcChunk(msg);
    } else if (msg.type === "update") {
      const u = { phase: msg.phase, pct: msg.pct, message: msg.message, version: msg.version };
      for (const cb of this.updateCbs) cb(u);
    } else if (msg.type === "notification") {
      const n = { sessionId: msg.sessionId, title: msg.title, body: msg.body, ts: msg.ts };
      for (const cb of this.notificationCbs) cb(n);
    } else if (msg.type === "error") {
      // A rejected pairing (expired/wrong/exhausted code) must not be retried:
      // the agent closes right after, and re-sending the same dead code on every
      // reconnect would loop forever and self-trip the rate limiter. Drop the
      // pending code so the next reconnect proceeds as a normal (unpaired) attempt.
      if (this.pairing && msg.code === "pair_failed") {
        this.pairing = false;
        clearPendingPair();
      }
      for (const cb of this.errorCbs) cb({ code: msg.code, message: msg.message });
    }
  }

  // WP-6: collect rpcChunk frames per rpc id; once all slices are in, the
  // concatenated bytes ARE the original `response` frame's JSON, so feeding
  // the decoded text back through dispatch makes a chunked response behave
  // byte-for-byte like the single-frame path (resolve/reject, unknown-id
  // drop included).
  private handleRpcChunk(msg: { id: string; index: number; total: number; data: string }): void {
    // Late chunks for an unknown id (rpc already settled/timed out) are
    // dropped silently — the buffer can only exist alongside a pending rpc.
    if (!this.pending.has(msg.id)) return;
    const r = this.chunks.feed(msg);
    if (r.status === "pending") return;
    if (r.status === "error") {
      const p = this.pending.get(msg.id);
      this.chunks.drop(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        this.sched.clearTimeout(p.timer);
        const e = new Error(`rpc_chunk_invalid:${r.reason}`) as Error & { code?: string };
        e.code = "rpc_chunk_invalid";
        p.reject(e);
      }
      return;
    }
    this.dispatch(new TextDecoder().decode(r.bytes));
  }

  // A frame may go out only once the secure channel is established AND any
  // in-channel pairing has completed (the agent answers nothing but pair until
  // then). attach/detach gate on this instead of the offline queue: their
  // subscription state is rebuilt by flushAndRestore on every (re)connect, so
  // queueing them would only duplicate the attach and the backlog replay.
  private transportReady(): boolean {
    return this.open && !this.pairing && !!this.channel && this.channel.state === "transport";
  }

  private send(msg: ClientMsg): void {
    const raw = encode(msg);
    if (this.open && this.channel && this.channel.state === "transport") {
      this.ws.send(this.channel.send(new Uint8Array(new TextEncoder().encode(raw))));
    } else {
      this.queue.push(raw);
    }
  }

  newSession(name: string, opt: { cmd?: string; cwd?: string; kind?: "tmux" | "shell" } = {}): void {
    this.send({ type: "newSession", name, cmd: opt.cmd, cwd: opt.cwd, kind: opt.kind });
  }
  attach(sessionId: string, lastSeq?: number): void {
    const subscribed = this.attached.has(sessionId);
    this.attached.add(sessionId);
    const seq = this.seen.get(sessionId) ?? lastSeq ?? 0;
    // Persist the resume point so the reconnect replay (flushAndRestore) picks
    // it up even when this attach happened while the transport was down.
    if (!this.seen.has(sessionId)) this.seen.set(sessionId, seq);
    // No frame when the server is already subscribed on this socket (remount /
    // restored-tab re-attach): a duplicate attach only re-sends the backlog.
    // No frame while the transport is down either: flushAndRestore re-attaches
    // every bookkeeping entry on the next established connection.
    if (subscribed || !this.transportReady()) return;
    this.send({ type: "attach", sessionId, lastSeq: seq });
  }
  sendInput(sessionId: string, data: Uint8Array): void {
    this.send({ type: "input", sessionId, data: toB64(data) });
    // Local echo of the outbound path: every input source (custom keyboard,
    // snippet insert, file-panel `cd`, hint chip) funnels through here, so
    // this is the single place a listener can hook "the user just typed" —
    // e.g. Terminal re-classifies the pane right away instead of waiting for
    // the next 2s poll (fast alt-screen entry for `vim x<CR>`).
    for (const cb of this.inputCbs) cb(sessionId);
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
  listDevices(): void { this.send({ type: "listDevices" }); }
  revokeDevice(pubKey: string): void { this.send({ type: "revokeDevice", pubKey }); }
  listSnippets(): void { this.send({ type: "listSnippets" }); }
  addSnippet(i: { group: string; label: string; command: string; autoEnter: boolean }): void {
    this.send({ type: "addSnippet", group: i.group, label: i.label, command: i.command, autoEnter: i.autoEnter });
  }
  removeSnippet(id: string): void { this.send({ type: "removeSnippet", id }); }
  onSnippets(cb: (s: Snippet[]) => void): () => void {
    this.snippetsCbs.push(cb);
    return () => { this.snippetsCbs = this.snippetsCbs.filter((c) => c !== cb); };
  }
  onDevices(cb: (d: DeviceInfo[]) => void): () => void {
    this.devicesCbs.push(cb);
    return () => { this.devicesCbs = this.devicesCbs.filter((c) => c !== cb); };
  }
  onUpdate(cb: UpdateCb): () => void {
    this.updateCbs.push(cb);
    return () => { this.updateCbs = this.updateCbs.filter((c) => c !== cb); };
  }
  checkUpdate(force = false): Promise<unknown> { return this.rpc("update.check", { force }); }
  applyUpdate(): Promise<unknown> { return this.rpc("update.apply"); }
  sendPresence(foreground: boolean, activeSessionId: string | null): void {
    this.send({ type: "presence", foreground, activeSessionId });
  }
  onNotification(cb: NotificationCb): () => void {
    this.notificationCbs.push(cb);
    return () => { this.notificationCbs = this.notificationCbs.filter((c) => c !== cb); };
  }
  notifyGetConfig(): Promise<unknown> { return this.rpc("notify.getConfig"); }
  notifySetConfig(config: unknown): Promise<unknown> { return this.rpc("notify.setConfig", { config }); }
  notifyGetVapidKey(): Promise<{ publicKey: string }> { return this.rpc("notify.getVapidPublicKey") as Promise<{ publicKey: string }>; }
  notifySubscribe(subscription: unknown): Promise<unknown> { return this.rpc("notify.subscribeWebPush", { subscription }); }
  notifyUnsubscribe(): Promise<unknown> { return this.rpc("notify.unsubscribeWebPush"); }
  notifyTestWebhook(id: string): Promise<{ ok: boolean; error?: string }> { return this.rpc("notify.testWebhook", { id }) as Promise<{ ok: boolean; error?: string }>; }
  notifyWire(tool: string): Promise<{ ok: boolean; reason?: string; detail?: string }> { return this.rpc("notify.wire", { tool }) as Promise<{ ok: boolean; reason?: string; detail?: string }>; }
  notifyUnwire(tool: string): Promise<{ ok: boolean; reason?: string; detail?: string }> { return this.rpc("notify.unwire", { tool }) as Promise<{ ok: boolean; reason?: string; detail?: string }>; }
  onOutput(cb: OutputCb): () => void {
    this.outputCbs.push(cb);
    return () => {
      this.outputCbs = this.outputCbs.filter((c) => c !== cb);
    };
  }
  onInput(cb: InputCb): () => void {
    this.inputCbs.push(cb);
    return () => {
      this.inputCbs = this.inputCbs.filter((c) => c !== cb);
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
    const wasAttached = this.attached.delete(sessionId);
    // `seen` is kept on purpose: re-attaching later (back to the foreground)
    // resumes the replay from the last received seq instead of refetching the
    // whole backlog. While the transport is down no frame is needed — a fresh
    // connection starts with an empty subscription set server-side anyway.
    if (!wasAttached || !this.transportReady()) return;
    this.send({ type: "detach", sessionId });
  }
}
