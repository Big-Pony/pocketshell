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
import { gunzip } from "../gunzip";
import { buildRpcReport } from "../term/reseed";
import { BIN_FRAME_MAGIC, packBinFrame, unpackBinFrame } from "./binframe";

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
type GapCb = (f: { sessionId: string; expected: number; got: number; missing: number }) => void;
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

// 12 期 rpc 压缩埋点：只上报明显大的 rpc，小 rpc 高频且不关心，全报会刷屏日志。
const RPC_DIAG_SAMPLE_MIN_BYTES = 8192;

export class Connection {
  private ws!: WebSocketLike;
  private open = false;
  // 离线队列。二进制帧塞不进 string[]，所以元素是「已编码的 JSON 文本」或
  // 「已打包的二进制帧字节」二选一，flushAndRestore 按类型分发。
  private queue: (string | Uint8Array)[] = [];
  /** agent 声明的可选能力（sessions.features）。见到 "bin" 才发二进制上行。 */
  private features = new Set<string>();
  private outputCbs: OutputCb[] = [];
  private inputCbs: InputCb[] = [];
  private sessionsCbs: SessionsCb[] = [];
  private exitCbs: ExitCb[] = [];
  private errorCbs: ErrorCb[] = [];
  private resyncCbs: ResyncCb[] = [];
  private gapCbs: GapCb[] = [];
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
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number; bytes?: number; method: string; startedAt: number }>();
  // 已发出但未结算的 rpc 字节总量，用于把死线按排队量放大（见 rpcDeadlineMs）。
  private inflightBytes = 0;
  // WP-6: rpcChunk reassembly buffers share the pending rpc's exact lifetime —
  // dropped on settle/timeout, cleared on disconnect.
  private chunks = new ChunkReassembler();
  // 12 期 rpc 压缩埋点：handleRpcZip/handleRpcChunk 在回喂 dispatch() 之前把
  // 「这次响应实际走了多少线上字节 / 压缩前多少字节 / 几片」记在这里，
  // dispatch() 的 response 分支读一次就清空。未设置（明帧 response 直接
  // 到达）时 response 分支自己用 raw 的字节数当 wireBytes=rawBytes、chunks=1。
  private rpcWireOverride: { wireBytes: number; rawBytes: number; chunks: number } | null = null;

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

  /**
   * Tear down the current socket and let the normal reconnect path take over.
   *
   * Mirrors what the heartbeat liveness timeout does: stop the heartbeat, close
   * the socket, and let `onclose` land in `handleDown()` so status, metrics and
   * backoff all follow the same path a real network drop would take. Exposed so
   * callers can exercise the offline/reconnect flow deterministically instead of
   * waiting out the liveness window.
   */
  dropConnection(): void {
    this.stopHeartbeat();
    this.ws.close();
  }

  dispose(): void {
    this.stopHeartbeat();
    this.clearHsTimer();
    if (this.reconnectTimer !== undefined) this.sched.clearTimeout(this.reconnectTimer);
    this.rejectAllPending();
    this.ws.close();
  }

  /**
   * @param opts.expectBytes 预期**响应体**的字节数。传输类调用点（下载分片）
   *   本来就知道要拿多少字节（`len` 就在参数里），由它显式告知，见下方记账注释。
   *   不传即维持原行为，既有全部调用点零变化。
   */
  rpc(method: string, params?: unknown, opts?: { expectBytes?: number }): Promise<unknown> {
    const id = String(++this.rpcSeq);
    // acceptEnc: 声明本端认得 gzip 压缩的响应与二进制帧承载。agent 只在看到
    // 对应值时才用，所以老 agent（忽略未知字段）与新 agent 都能正确工作。
    const msg = { type: "rpc", id, method, params, acceptEnc: ["gzip", "bin"] } as ClientMsg;
    const raw = encode(msg);
    // 出站字节 + **预期入站字节**。后者此前完全不入账，导致下载方向的死线
    // 恒为 10s：56KB 的响应体在慢链路上根本来不及收完，健康的下载整体失败
    // （上传方向的 rpcBin 一直计整帧，是对的——这是一处上下行不对称）。
    // 窗口提到 16 之后尤其致命：16 lane 各等一个 56KB 响应体。
    const bytes = raw.length + Math.max(0, opts?.expectBytes ?? 0); // UTF-8 ≈ length here; payloads are base64/ASCII
    const startedAt = this.sched.now();
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
      this.pending.set(id, { resolve, reject, timer, bytes, method, startedAt });
      this.send(msg);
    });
  }

  /**
   * 带裸字节载荷的 rpc。blob 走二进制帧尾，不进 JSON。
   *
   * 老 agent（没在 sessions 里声明 "bin"）自动回落到 base64 —— 上行方向无法
   * 从自身版本推断对端版本，而"旧 app 撞新 agent"可达：shouldReloadAfterUpdate
   * 只在亲眼看着 OTA 发生的那个页面才 reload，后台标签页与手工重启都不会。
   */
  rpcBin(method: string, params: unknown, blob: Uint8Array): Promise<unknown> {
    if (!this.features.has("bin")) {
      // 回落：与一阶段完全一致的普通 rpc。
      return this.rpc(method, { ...(params as object), dataB64: toB64(blob) });
    }
    const id = String(++this.rpcSeq);
    const header = { type: "rpc", id, method, params, acceptEnc: ["gzip", "bin"] };
    const frame = packBinFrame(header, blob);
    // 记账用**整帧**字节，不是 header 字节。死线按 inflightBytes 放大，只记
    // header 会让 4 片窗口的死线从 39413ms 塌回 10000ms 下限，慢上行上健康的
    // 上传会整体失败。这条回环下复现不出来。
    const bytes = frame.byteLength;
    const startedAt = this.sched.now();
    return new Promise<unknown>((resolve, reject) => {
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
      this.pending.set(id, { resolve, reject, timer, bytes, method, startedAt });
      // transport 门控：SecureChannel.send 在非 transport 状态**同步 throw**。
      // 与既有 send() 的判断逐字一致。
      if (this.open && this.channel && this.channel.state === "transport") {
        this.sendRawBytes(this.ws, frame);
      } else {
        this.queue.push(frame);
      }
    });
  }

  // 12 期 rpc 压缩埋点：这轮压缩到底省了多少、哪条路径值得下一轮上 brotli 或
  // 二进制帧。只放计数与方法名，不放任何载荷内容——这条日志用户可能直接贴进
  // 公开 issue。字段名与 agent 侧 diag-report.ts 的白名单逐字对应，漂移是
  // 静默的。只上报 wireBytes 明显大的一批，小 rpc 高频且不关心。
  //
  // C1：仅按 wireBytes 门槛采样对方法无差别，fs.downloadChunk 之类在压缩
  // 黑名单里的方法响应恒为 45KB base64 ≈ 61531 字节，永远越过门槛——200MB
  // 下载 4552 个分片就是 4552 次白打的 diag rpc，且与下载窗口（4 路并发）
  // 抢同一条链路，慢链路上是实打实的拖累。这些记录还信息量为零：黑名单方法
  // 的 wireBytes 恒等于 rawBytes，压缩率永远 1.0。所以额外要求"压缩真的
  // 生效过"——没压成功的样本本来就回答不了"这轮压缩省了多少"这个问题。
  private reportRpcIfBig(method: string, rttMs: number, wireBytes: number, rawBytes: number, chunks: number): void {
    if (!this.features.has("diag")) return;   // 诊断默认关闭（2026-08-23）
    if (wireBytes <= RPC_DIAG_SAMPLE_MIN_BYTES) return;
    if (wireBytes >= rawBytes) return;
    void this.rpc("diag.report", buildRpcReport({ method, rttMs, wireBytes, rawBytes, chunks })).catch(() => {});
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
      // rpc 二进制帧编码：明文的第一个字节区分二进制帧（0x00 magic）与 JSON
      // 文本（'{' = 0x7B）。TextDecoder 之前判断——二进制帧里的 blob 可能不是
      // 合法 UTF-8，先解码文本会把它损坏。
      const plain = r.plaintext;
      if (plain.length > 0 && plain[0] === BIN_FRAME_MAGIC) {
        const bf = unpackBinFrame(plain);
        if (bf) this.dispatchBin(bf.header as { type?: string }, bf.blob);
        // 坏帧（unpackBinFrame 返回 null）静默丢弃：不关连接、不杀掉后续帧处理。
        return;
      }
      this.dispatch(new TextDecoder().decode(plain));
    };
    socket.onclose = () => {
      if (socket !== this.ws) return;
      this.handleDown();
    };
  }

  private flushAndRestore(socket: WebSocketLike): void {
    const pending = this.queue; this.queue = [];
    for (const raw of pending) {
      if (typeof raw === "string") this.sendRaw(socket, raw);
      else this.sendRawBytes(socket, raw);
    }
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
    // 见 rpcWireOverride 字段注释：读一次即清空，只在 handleRpcZip/
    // handleRpcChunk 紧邻的回喂里才非空，其它消息类型永远拿到 null。
    const wireOverride = this.rpcWireOverride;
    this.rpcWireOverride = null;
    let msg;
    try {
      msg = decodeServer(raw);
    } catch (e) {
      console.error("[Connection] dropped malformed frame", e);
      return;
    }
    if (msg.type === "output") {
      const prev = this.seen.get(msg.sessionId) ?? 0;
      // 【2026-08-22】seq 缺口检测。「内容中间少几行、上下都在」这类故障靠
      // 症状分不清是哪条路径丢的（背压主动丢帧 / 传输静默丢 / 渲染层），而
      // seq 是服务端单调递增发的，缺号即丢帧且能定位到具体区间。
      //
      // 只在 prev>0（已建立记账）且真的跳号时上报，两个条件缺一不可：
      //   - prev===0 是首帧或 seed 之后，此时跳号是正常的（服务端从快照 seq
      //     之后开始发，客户端本来就没见过中间那些）；
      //   - seq<=prev 是重发/乱序，不是缺口，且 attach 后必然出现一批。
      if (prev > 0 && msg.seq > prev + 1) {
        for (const cb of this.gapCbs) cb({ sessionId: msg.sessionId, expected: prev + 1, got: msg.seq, missing: msg.seq - prev - 1 });
      }
      if (msg.seq > prev) this.seen.set(msg.sessionId, msg.seq);
      const f = { sessionId: msg.sessionId, seq: msg.seq, data: fromB64(msg.data) };
      for (const cb of this.outputCbs) cb(f);
    } else if (msg.type === "resync") {
      for (const cb of this.resyncCbs) cb({ sessionId: msg.sessionId, from: msg.from });
    } else if (msg.type === "sessions") {
      if (Array.isArray(msg.features)) this.features = new Set(msg.features);
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
        if (msg.ok) {
          p.resolve(msg.result);
          // 未走 rpcZip/rpcChunk 的明帧：wireBytes = rawBytes = 这一帧的字节数。
          const wire = wireOverride ?? (() => {
            const n = new TextEncoder().encode(raw).length;
            return { wireBytes: n, rawBytes: n, chunks: 1 };
          })();
          this.reportRpcIfBig(p.method, this.sched.now() - p.startedAt, wire.wireBytes, wire.rawBytes, wire.chunks);
        }
        else { const e = new Error(msg.error.message) as Error & { code?: string }; e.code = msg.error.code; p.reject(e); }
      }
    } else if (msg.type === "rpcZip") {
      // 兼容旧 JSON 帧：agent 侧「未压缩但超单帧预算」的响应仍走纯 JSON 老路径
      // （chunkRpcPayload + sendSecure），只有压缩后的 rpcZip/rpcChunk 才走
      // 二进制帧。handleRpcZip 已改成 bytes-only，这里把 base64 转好再喂进去；
      // fromB64 同步抛时按坏帧处理（走与二进制路径一致的清理顺序），不让异常
      // 冒泡到没有 try/catch 的 onmessage。
      try {
        this.handleRpcZip({ id: msg.id, bytes: fromB64(msg.data) });
      } catch {
        this.rejectPendingRpc(msg.id, "rpc_zip_invalid");
      }
    } else if (msg.type === "rpcChunk") {
      try {
        this.handleRpcChunk({ id: msg.id, index: msg.index, total: msg.total, bytes: fromB64(msg.data), enc: msg.enc });
      } catch {
        this.rejectPendingRpc(msg.id, "rpc_chunk_invalid", "rpc_chunk_invalid:bad_data");
      }
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

  // 二进制帧分流：header.type 决定走哪条结算路径。rpcZip/rpcChunk 与 JSON 帧
  // 到达时走同一套 bytes-only handler（dispatch() 里的 fromB64 兼容垫层负责
  // 把旧 JSON 帧的 base64 先转好）；rpcBin 是纯二进制专属的新结算路径，因为
  // 它的 result 里带裸字节，没法回喂 dispatch() 的 JSON 解析。
  private dispatchBin(header: { type?: string }, blob: Uint8Array): void {
    if (header.type === "rpcZip") {
      this.handleRpcZip({ id: (header as { id: string }).id, bytes: blob });
    } else if (header.type === "rpcChunk") {
      this.handleRpcChunk({ ...(header as { id: string; index: number; total: number; enc?: "gzip" }), bytes: blob });
    } else if (header.type === "rpcBin") {
      this.handleRpcBin(header as { id: string; result: unknown }, blob);
    }
    // 未知 type：静默丢弃（对称于 dispatch() 对未知 JSON 消息类型的处理）。
  }

  // 统一的「拒绝一个 pending rpc」清理顺序：先取 p，无条件 drop chunks（哪怕
  // p 已不在也要做——防御性地清掉可能残留的重组缓冲），再判断要不要走
  // pending 的完整清理。与 handleRpcZip/handleRpcChunk 原有 error 分支的顺序
  // 逐字一致，抽出来给 dispatch() 的兼容垫层复用。
  private rejectPendingRpc(id: string, code: string, message = code): void {
    const p = this.pending.get(id);
    this.chunks.drop(id);
    if (!p) return; // 已超时/已断线结算过，什么都不做
    this.pending.delete(id);
    this.releaseRpc(p);
    this.sched.clearTimeout(p.timer);
    const e = new Error(message) as Error & { code?: string };
    e.code = code;
    p.reject(e);
  }

  // rpcBin 独立结算路径：result 里带裸字节（下载分片等），不能像 rpcZip/
  // rpcChunk 那样回喂 dispatch() 的 JSON 解析（JSON 装不下任意字节）。手写
  // 结算：resolve 出 {...result, bytes}，bytes 是 unpackBinFrame 零拷贝视图
  // 的真拷贝（resolve 后调用方可能跨多帧持有它，不能钉住整帧 buffer）。
  // 不产生 rawBytes<wireBytes 的压缩埋点——rpcBin 没压缩任何东西，wireBytes
  // 就是 rawBytes，reportRpcIfBig 的 `wireBytes >= rawBytes` 门槛天然拦截。
  private handleRpcBin(header: { id: string; result: unknown }, blob: Uint8Array): void {
    const p = this.pending.get(header.id);
    if (!p) return; // 未知/已结算的 id：静默丢弃
    this.pending.delete(header.id);
    this.releaseRpc(p);
    this.chunks.drop(header.id);
    this.sched.clearTimeout(p.timer);
    const bytes = blob.slice();
    p.resolve({ ...(header.result as object), bytes });
    this.reportRpcIfBig(p.method, this.sched.now() - p.startedAt, bytes.length, bytes.length, 1);
  }

  // 压缩响应：解压后把原始 response 帧文本回喂 dispatch —— 与 rpcChunk 重组
  // 后的回喂是同一个招式，所以 resolve/reject/未知 id 丢弃全都免费复用。
  //
  // 三条纪律（少一条就是 bug）：
  //  1. gunzip 的 rejection 要接住。裸奔的同步异常会冒泡到没有 try/catch
  //     的 onmessage，杀掉整帧处理（bytes 已经是裸字节，不会再有 fromB64
  //     那种同步抛——调用方若来自 JSON 兼容垫层，抛的地方已经在 dispatch()
  //     自己的 try/catch 里处理过了）。
  //  2. 回喂前必须重新检查 socket —— 异步路径绕过了 onmessage 的
  //     `if (socket !== this.ws) return`，重连/dispose 后旧 promise 落地时
  //     那层保护已经不在了。
  //  3. 这条路径除 dispatch() 外**不得触碰任何连接状态**（pending / chunks /
  //     inflightBytes）。想"提前退出省点 CPU"就会重复释放。
  private handleRpcZip(msg: { id: string; bytes: Uint8Array }): void {
    const socket = this.ws;
    const wireBytes = msg.bytes.length;
    gunzip(msg.bytes).then(
      (raw) => {
        if (socket !== this.ws) return; // 纪律 2
        // 埋点：wireBytes 是本次响应实际上线的字节（压缩后），raw 的长度是
        // 压缩前的大小。仅供 dispatch() 里 response 分支读一次，不算作
        // 纪律 3 触碰连接状态（这是只读诊断）。
        this.rpcWireOverride = { wireBytes, rawBytes: raw.length, chunks: 1 };
        this.dispatch(new TextDecoder().decode(raw)); // 纪律 3：只做这一件事
      },
      () => {
        if (socket !== this.ws) return;
        this.rejectPendingRpc(msg.id, "rpc_zip_invalid");
      },
    );
  }

  // WP-6: collect rpcChunk frames per rpc id; once all slices are in, the
  // concatenated bytes ARE the original `response` frame's JSON, so feeding
  // the decoded text back through dispatch makes a chunked response behave
  // byte-for-byte like the single-frame path (resolve/reject, unknown-id
  // drop included).
  private handleRpcChunk(msg: { id: string; index: number; total: number; bytes: Uint8Array; enc?: "gzip" }): void {
    // Late chunks for an unknown id (rpc already settled/timed out) are
    // dropped silently — the buffer can only exist alongside a pending rpc.
    if (!this.pending.has(msg.id)) return;
    const r = this.chunks.feed(msg);
    if (r.status === "pending") return;
    if (r.status === "error") {
      this.rejectPendingRpc(msg.id, "rpc_chunk_invalid", `rpc_chunk_invalid:${r.reason}`);
      return;
    }
    // 带 enc 的分片：重组出来的是 gzip 字节，还要解压一次才是 response JSON。
    // 与 handleRpcZip 同样的三条纪律。
    if (msg.enc === "gzip") {
      const socket = this.ws;
      const id = msg.id;
      const total = msg.total;
      gunzip(r.bytes).then(
        (raw) => {
          if (socket !== this.ws) return;
          // 埋点：r.bytes 是分片重组出的 gzip 字节（本次响应实际上线的字节），
          // 解压后的 raw 是压缩前的大小；total 是分片数。
          this.rpcWireOverride = { wireBytes: r.bytes.length, rawBytes: raw.length, chunks: total };
          this.dispatch(new TextDecoder().decode(raw));
        },
        () => {
          if (socket !== this.ws) return;
          this.rejectPendingRpc(id, "rpc_zip_invalid");
        },
      );
      return;
    }
    // 未压缩的分片：wireBytes = rawBytes = 重组出的字节数（本来就没压过）。
    this.rpcWireOverride = { wireBytes: r.bytes.length, rawBytes: r.bytes.length, chunks: msg.total };
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

  /**
   * 二进制帧的出站口。与 sendRaw 并列，**同样负责上行记账** —— sendRaw 的
   * 注释自称"唯一的出站口……免得日后新增一条消息路径时又漏了记账"，这就是
   * 那条新路径，漏了 txBytes 分割条的上行吞吐会在上传期间显示为 0，而上传
   * 恰恰是唯一在意上行数字的场景。
   */
  private sendRawBytes(socket: WebSocketLike, frame: Uint8Array): void {
    const enc = this.channel.send(frame);
    this.txBytes += enc.byteLength;
    socket.send(enc);
  }

  // 新建会话时捎上本机上次的可信尺寸（recallDims）。目的不是省一次 resize，而是
  // 让会话**从第一个字节起**就按本机宽度排版：agent 默认的 80x24 与手机实际的
  // ~41 列差得远，而在第一次 refit 纠正之前，Claude Code 已经按 80 列把硬换行打
  // 进历史了——那部分 tmux 反折不回来（详见 lib/term/fit-guard.ts）。
  // 读不到兜底时不传，行为与从前一致。
  newSession(
    name: string,
    opt: { cmd?: string; cwd?: string; kind?: "tmux" | "shell"; cols?: number; rows?: number } = {},
  ): void {
    this.send({ type: "newSession", name, cmd: opt.cmd, cwd: opt.cwd, kind: opt.kind, cols: opt.cols, rows: opt.rows });
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
    // 订阅是**按会话名**记的。服务端在 rename 成功后把订阅从旧名迁到新名（server.ts
    // 的 renameSession 分支），本地这份账必须跟着迁，否则两件事会坏：
    //   1. 旧名留在 attached 里 —— 用户拿这个名字**新建**一个会话时，attach() 的
    //      `subscribed` 早退守卫会认为「这条连接已经订阅过了」而不发 attach 帧；服务端
    //      那侧却从来没有过这个订阅，新会话的每一帧输出都被 deliverOutput 之前的
    //      `conn.subscriptions.has(name)` 丢掉 —— 表现为「这个窗口输入什么都不显示，
    //      别的窗口全正常」，且只有断线重连（flushAndRestore 重发全部 attach）能自愈。
    //      2026-08-26 实测复现：重命名 aippt→teachppt 之后新建的 aippt 正是如此。
    //   2. 新名不在 attached 里 —— 下次重连时 flushAndRestore 不会重新订阅它。
    // rename 万一失败（服务端回 rename_failed），这次迁移是错的，但代价只是下次激活
    // 该标签页时多发一次 attach（重复 attach 只多补一遍 backlog），不会丢字节。
    if (this.attached.delete(sessionId)) this.attached.add(name);
    // seq 账**不能**跟着迁：服务端的 replay 环同样按名字建，新名字是一条从头开始的
    // 新环，把旧名的高 seq 带过去会让 attach 算出一个假缺口。旧名的进度也必须清掉，
    // 否则同名会话被重建时会拿着旧 seq 去要回放，开头那几帧会被当成「已经收过」而
    // 静默跳过。
    this.seen.delete(sessionId);
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
  /** 诊断推送（14 期需求 4）。ok 只表示推送服务受理了，送达与否由 sw.js 回报。 */
  notifyTestPush(): Promise<{ ok: boolean; error?: string }> { return this.rpc("notify.testPush", {}) as Promise<{ ok: boolean; error?: string }>; }
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
  /**
   * agent 是否声明了某个能力位（sessions.features）。
   *
   * 诊断埋点用它（`hasFeature("diag")`）：agent 默认不开诊断，客户端就**不该
   * 开始采样**——否则每个活跃会话每 15s 仍要跑三条 rpc，只是服务端把结果丢掉，
   * 白烧手机电量。老 agent 不发这个位，采样自然也不开。
   */
  hasFeature(name: string): boolean {
    return this.features.has(name);
  }

  /** seq 跳号时触发。缺口 = 服务端发了但客户端没收到的帧，见 onFrame 的注释。 */
  onSeqGap(cb: GapCb): () => void {
    this.gapCbs.push(cb);
    return () => { this.gapCbs = this.gapCbs.filter((c) => c !== cb); };
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
