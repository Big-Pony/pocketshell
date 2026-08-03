// B1 (slice-1, plaintext): the app's single network entry point. WS connect,
// encode/decode, dispatch. Noise handshake, reconnect state machine, secure
// storage, pairing, and rpc() are added in later slices.
// S4b: in-channel pairing — send pair on established, await paired, then normal flow.
import { encode, decodeServer, type ClientMsg, type SessionMeta, type DeviceInfo, type Snippet, type Hint } from "./protocol";
import { toB64, fromB64 } from "../bytes";
import { ChunkReassembler } from "./rpc-chunks";
import { createInitiatorChannel, type SecureChannel } from "./secure-channel";
import { loadOrCreateIdentity, getAgentPubKey, getPendingPair, clearPendingPair } from "./keystore";
import { tr } from "../i18n";

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
// The bytes are handed to listeners as well as the session id: "the user just
// typed" is not enough for a listener that needs to know WHAT was typed (the
// copy-output anchor only moves on a Return). Purely additive — existing
// listeners that take one argument keep working.
type InputCb = (sessionId: string, data: Uint8Array) => void;
type UpdateCb = (u: { phase: string; pct?: number; message?: string; version?: string }) => void;
type NotificationCb = (m: { sessionId: string; title: string; body: string; ts: number }) => void;

/**
 * 分割条要的链路指标。全部来自既有数据流的记账：延迟复用心跳（ping/pong 本就
 * 在跑），吞吐是收发帧的字节累加——不新增协议、不新增定时器、不新增采样。
 * latency 为 null 表示当前无有效样本（刚连上 / 连丢两个心跳周期 / 已断线）。
 */
export interface LinkMetrics {
  latency: number | null;
  /** 结算窗口内收到的密文字节数（链路实际下行流量） */
  rxBytes: number;
  /** 结算窗口内发出的密文字节数（上行只有按键，暂不显示，留作日后用） */
  txBytes: number;
  /** 窗口时长，供 formatRate 算速率 */
  elapsedMs: number;
}

type MetricsCb = (m: LinkMetrics) => void;

// ---- rpc 死线 ----
// 旧实现给每个 rpc 一个固定 10s 死线，但计时器在**入队**那一刻就开始跑：
// uploadChunksWindowed 会同时压 4 片、每片上线约 60KB，第 4 片的预算全耗在
// 等前 3 片排空上。上行低于约 200kbps 时这个死线物理上不可能满足，健康的上传
// 会在几百 KB 处整体失败（实测 150kbps 必现，同链路把窗口降到 1 就正常）。
//
// 改为按「排在前面 + 自己」的字节数放大：基线仍是 10s（小 rpc 行为不变，
// 活性检测照旧），再按一个保守的最低可用带宽折算传输时间。这不是在猜真实
// 带宽，而是给出一个「慢到这个程度也不该判死」的下界。
export const RPC_BASE_TIMEOUT_MS = 10_000;
// 保守下界：50kbps 有效上行。比这更慢的链路上传本来也没有可用性可言。
const MIN_ASSUMED_BYTES_PER_SEC = (50 * 1000) / 8;
// 硬上限：再慢也必须有个尽头，否则 agent 假死时前端会永远挂着。
export const RPC_MAX_TIMEOUT_MS = 5 * 60_000;

// 10s 基线本身就够排空这么多字节（按上面的下界算），所以只有超出这部分的
// 排队量才需要额外加时——小 rpc 因此拿到的仍是**恰好** 10s，行为零变化。
const BASE_COVERED_BYTES = (RPC_BASE_TIMEOUT_MS / 1000) * MIN_ASSUMED_BYTES_PER_SEC;

/** 给定「本次 rpc 及其之前排队的字节数」，算出该用多长的死线。 */
export function rpcDeadlineMs(queuedBytes: number): number {
  const excess = Math.max(0, queuedBytes - BASE_COVERED_BYTES);
  const drainMs = (excess / MIN_ASSUMED_BYTES_PER_SEC) * 1000;
  return Math.min(RPC_MAX_TIMEOUT_MS, RPC_BASE_TIMEOUT_MS + drainMs);
}

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
  private hintsChangedCbs: (() => void)[] = [];
  private updateCbs: UpdateCb[] = [];
  private notificationCbs: NotificationCb[] = [];
  private establishedThisSocket = false;
  private pairFailStreak = 0;
  private rpcSeq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number; bytes?: number }>();
  // 已发出但未结算的 rpc 字节总量，用于把死线按排队量放大（见 rpcDeadlineMs）。
  private inflightBytes = 0;
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

  // ---- 链路指标（分割条）----
  private metricsCbs: MetricsCb[] = [];
  // 只跟踪最近一个 ping 的时间戳，不做队列。协议里 ping/pong 不带 id，两者
  // 在线路上无法一一对应，所以用「未回应 ping 计数」判定样本是否可信：
  // 计数为 1 时收到的 pong 必然对应 pingSentAt，算出的 RTT 有效；计数 >1 说明
  // 这个 pong 属于某个更早的、时间戳已被覆盖的 ping，样本作废——否则会把
  // 「最近一次 ping 至今的时长」当成 RTT 显示出一个明显偏小的错误数字。
  private pingSentAt: number | null = null;
  private pingsOutstanding = 0;
  private latency: number | null = null;
  // 连续多少个心跳周期没拿到 RTT 样本。超过 2 个周期就清空，避免长期显示
  // 一个早已过期的数字。
  private missedPongs = 0;
  private rxBytes = 0;
  private txBytes = 0;
  private windowStart = 0;

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

  /** 订阅链路指标（延迟 / 吞吐）。每个心跳周期结算一次。 */
  onMetrics(cb: MetricsCb): () => void {
    this.metricsCbs.push(cb);
    return () => { this.metricsCbs = this.metricsCbs.filter((c) => c !== cb); };
  }

  /** 结算并广播一个窗口，然后清零重新计。心跳定时器与断线时各调一次。 */
  private emitMetrics(): void {
    const now = this.sched.now();
    const m: LinkMetrics = {
      latency: this.latency,
      rxBytes: this.rxBytes,
      txBytes: this.txBytes,
      elapsedMs: Math.max(0, now - this.windowStart),
    };
    this.rxBytes = 0;
    this.txBytes = 0;
    this.windowStart = now;
    for (const cb of this.metricsCbs) cb(m);
  }

  private resetMetrics(): void {
    this.pingSentAt = null;
    this.pingsOutstanding = 0;
    this.latency = null;
    this.missedPongs = 0;
    this.rxBytes = 0;
    this.txBytes = 0;
    this.windowStart = this.sched.now();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastRx = this.sched.now();
    this.resetMetrics();
    this.hbTimer = this.sched.setInterval(() => {
      if (this.sched.now() - this.lastRx > this.livenessMs) {
        this.stopHeartbeat();
        this.ws.close();
        return;
      }
      // 上一轮的 ping 没等到 pong：连丢两轮就把延迟清空（宁可不显示，也不
      // 显示一个过期数字）。
      if (this.pingsOutstanding > 0 && ++this.missedPongs >= 2) this.latency = null;
      // 心跳周期即结算窗口——复用同一个定时器，不新增 timer。
      this.emitMetrics();
      if (this.open && this.channel.state === "transport") {
        this.pingSentAt = this.sched.now();
        this.pingsOutstanding++;
        this.send({ type: "ping" });
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
    const raw = encode({ type: "rpc", id, method, params } as ClientMsg);
    const bytes = raw.length; // UTF-8 ≈ length here; payloads are base64/ASCII
    return new Promise<unknown>((resolve, reject) => {
      // The deadline covers everything queued AHEAD of this call too: on a
      // slow uplink those bytes must drain before this rpc's own bytes even
      // start moving, and its timer is already running the whole time.
      const budgetFor = this.inflightBytes + bytes;
      const timer = this.sched.setTimeout(() => {
        this.releaseRpc({ bytes });
        this.pending.delete(id);
        this.chunks.drop(id);
        const e = new Error("rpc_timeout") as Error & { code?: string };
        e.code = "rpc_timeout";
        reject(e);
      }, rpcDeadlineMs(budgetFor));
      this.inflightBytes += bytes;
      this.pending.set(id, { resolve, reject, timer, bytes });
      this.send({ type: "rpc", id, method, params });
    });
  }

  /** Release an rpc's queued-byte reservation once it settles (any outcome). */
  private releaseRpc(p: { bytes?: number }): void {
    this.inflightBytes = Math.max(0, this.inflightBytes - (p.bytes ?? 0));
  }

  private rejectAllPending(): void {
    for (const [, p] of this.pending) {
      this.sched.clearTimeout(p.timer);
      const e = new Error("disconnected") as Error & { code?: string };
      e.code = "disconnected";
      p.reject(e);
    }
    this.pending.clear();
    this.inflightBytes = 0;
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
      // 下行记账：密文帧长度 = 链路实际流量（含握手帧，它也确实占带宽）。
      this.rxBytes += bytes.byteLength;
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
    for (const raw of pending) this.sendRaw(socket, raw);
    for (const id of this.attached) {
      this.sendRaw(socket, encode({ type: "attach", sessionId: id, lastSeq: this.seen.get(id) ?? 0 }));
    }
    this.sendRaw(socket, encode({ type: "listSessions" }));
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
      this.sendRaw(socket, encode({ type: "pair", code: pair.code, deviceName: pair.deviceName }));
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
    // 断线期间延迟与吞吐显示为空（不是 `--` 占位）：先清零再广播一次，
    // 订阅者立刻看到空值，不会停在断线前的最后一个数字上。
    this.resetMetrics();
    this.emitMetrics();
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
    } else if (msg.type === "hintsChanged") {
      for (const cb of this.hintsChangedCbs) cb();
    } else if (msg.type === "response") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        this.releaseRpc(p);
        this.chunks.drop(msg.id); // defensive: single frame after partial chunks
        this.sched.clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else { const e = new Error(msg.error.message) as Error & { code?: string }; e.code = msg.error.code; p.reject(e); }
      }
    } else if (msg.type === "rpcChunk") {
      this.handleRpcChunk(msg);
    } else if (msg.type === "pong") {
      // 恰好一个未回应的 ping 时，这个 pong 必然是它的回应，RTT 可信。
      // 多于一个说明有 pong 迟到，无法判断这个 pong 对应哪次 ping，样本作废
      // （只消账，不更新数字）。
      if (this.pingsOutstanding === 1 && this.pingSentAt !== null) {
        this.latency = Math.max(0, this.sched.now() - this.pingSentAt);
        this.missedPongs = 0;
      }
      if (this.pingsOutstanding > 0) this.pingsOutstanding--;
      if (this.pingsOutstanding === 0) this.pingSentAt = null;
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
        this.releaseRpc(p);
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
      this.sendRaw(this.ws, raw);
    } else {
      this.queue.push(raw);
    }
  }

  /**
   * 唯一的出站口：加密 + 发送 + 上行字节记账。所有 socket.send 都走这里，
   * 免得日后新增一条消息路径时又漏了记账。
   */
  private sendRaw(socket: WebSocketLike, raw: string): void {
    const frame = this.channel.send(new Uint8Array(new TextEncoder().encode(raw)));
    this.txBytes += frame.byteLength;
    socket.send(frame);
  }

  newSession(name: string, opt: { cmd?: string; cwd?: string; kind?: "tmux" | "shell" } = {}): void {
    this.send({ type: "newSession", name, cmd: opt.cmd, cwd: opt.cwd, kind: opt.kind });
  }
  // opts.seed：这次 attach 紧跟在一份 term.history 快照之后，传入的 seq 就是
  // 快照那一刻的进度，必须覆盖 seen —— 重挂载时 seen 里可能残留上一轮的旧值。
  //
  // 不传 seed 时保持原语义：seen 优先。断线重连的 flushAndRestore 依赖这条，
  // seen 是「我确实已收到第 N 帧」的真实进度，被更小的数覆盖会重放已看过的内容。
  attach(sessionId: string, lastSeq?: number, opts?: { seed?: boolean }): void {
    const subscribed = this.attached.has(sessionId);
    this.attached.add(sessionId);
    const seq = opts?.seed ? (lastSeq ?? 0) : (this.seen.get(sessionId) ?? lastSeq ?? 0);
    // Persist the resume point so the reconnect replay (flushAndRestore) picks
    // it up even when this attach happened while the transport was down.
    // A seed overwrites unconditionally; a plain attach only fills a gap.
    if (opts?.seed || !this.seen.has(sessionId)) this.seen.set(sessionId, seq);
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
    for (const cb of this.inputCbs) cb(sessionId, data);
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
  updateSnippet(id: string, i: { group: string; label: string; command: string; autoEnter: boolean }): void {
    this.send({ type: "updateSnippet", id, group: i.group, label: i.label, command: i.command, autoEnter: i.autoEnter });
  }
  removeSnippet(id: string): void { this.send({ type: "removeSnippet", id }); }
  onSnippets(cb: (s: Snippet[]) => void): () => void {
    this.snippetsCbs.push(cb);
    return () => { this.snippetsCbs = this.snippetsCbs.filter((c) => c !== cb); };
  }
  // 需求 5：读走 rpc（可被 rpcChunk 分片），写走专用消息，变更由
  // `hintsChanged` 通知各端自行重拉。
  listHints(): Promise<{ items: Hint[] }> { return this.rpc("hints.list") as Promise<{ items: Hint[] }>; }
  addHints(texts: string[]): void { this.send({ type: "addHints", texts }); }
  updateHint(id: string, text: string): void { this.send({ type: "updateHint", id, text }); }
  removeHint(id: string): void { this.send({ type: "removeHint", id }); }
  clearHints(): void { this.send({ type: "clearHints" }); }
  onHintsChanged(cb: () => void): () => void {
    this.hintsChangedCbs.push(cb);
    return () => { this.hintsChangedCbs = this.hintsChangedCbs.filter((c) => c !== cb); };
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
  agentInfo(): Promise<{ instanceName: string | null }> { return this.rpc("agent.info") as Promise<{ instanceName: string | null }>; }
  notifyGetConfig(): Promise<unknown> { return this.rpc("notify.getConfig"); }
  notifySetConfig(config: unknown): Promise<unknown> { return this.rpc("notify.setConfig", { config }); }
  notifyGetVapidKey(): Promise<{ publicKey: string }> { return this.rpc("notify.getVapidPublicKey") as Promise<{ publicKey: string }>; }
  notifySubscribe(subscription: unknown): Promise<unknown> { return this.rpc("notify.subscribeWebPush", { subscription }); }
  notifyUnsubscribe(): Promise<unknown> { return this.rpc("notify.unsubscribeWebPush"); }
  notifyTestWebhook(id: string): Promise<{ ok: boolean; error?: string }> { return this.rpc("notify.testWebhook", { id }) as Promise<{ ok: boolean; error?: string }>; }
  notifyWire(tool: string): Promise<{ ok: boolean; reason?: string; detail?: string }> { return this.rpc("notify.wire", { tool }) as Promise<{ ok: boolean; reason?: string; detail?: string }>; }
  notifyUnwire(tool: string): Promise<{ ok: boolean; reason?: string; detail?: string }> { return this.rpc("notify.unwire", { tool }) as Promise<{ ok: boolean; reason?: string; detail?: string }>; }
  // 需求 5：接管 Claude Code 的 statusLine 取上下文用量。与 notify.* 分开，
  // 因为它不产生通知，只取数字。
  contextWire(): Promise<{ ok: boolean; reason?: string; detail?: string }> { return this.rpc("context.wire", {}) as Promise<{ ok: boolean; reason?: string; detail?: string }>; }
  contextUnwire(): Promise<{ ok: boolean; reason?: string; detail?: string }> { return this.rpc("context.unwire", {}) as Promise<{ ok: boolean; reason?: string; detail?: string }>; }
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
