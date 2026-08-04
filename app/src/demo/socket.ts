// 演示用的 WebSocketLike 替身。Connection 只认这 6 个成员（connection.ts:12），
// 故整个传输层可被这一个类顶替，而 Connection 一个字都不用改。
//
// send() 收到的是**明文**字节（因为通道是恒等的），直接 JSON.parse 交给
// DemoAgent；反向由 agent 调 push() 送回。
import { HELLO, HELLO_ACK } from "./identity-channel";
import type { WebSocketLike } from "../lib/net/connection";

// Connection 首次重连退避约 500ms（connection.ts:446）。若立刻 open，
// 「重连中」在访客眼里根本没出现过就没了——而那正是演示的题眼。
export const RECONNECT_OPEN_DELAY_MS = 2500;

export interface DemoSocketOpts {
  /** 握手后收到的每一帧明文 JSON（已 parse）。 */
  onFrame(msg: unknown): void;
  /** 是否是重连。首次连接立即 open，重连才延迟。 */
  isReconnect: boolean;
  openDelayMs?: number;
  scheduler?: { setTimeout(fn: () => void, ms: number): number };
}

export class DemoSocket implements WebSocketLike {
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;

  private closed = false;
  private handshaken = false;
  private readonly opts: DemoSocketOpts;
  private readonly sched: { setTimeout(fn: () => void, ms: number): number };

  constructor(opts: DemoSocketOpts) {
    this.opts = opts;
    this.sched = opts.scheduler ?? { setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number };
  }

  /** 由工厂在构造后调用：安排 onopen。分开是为了让调用方先挂上回调。 */
  start(): void {
    const fire = () => { if (!this.closed) this.onopen?.(); };
    if (!this.opts.isReconnect) { fire(); return; }
    this.sched.setTimeout(fire, this.opts.openDelayMs ?? RECONNECT_OPEN_DELAY_MS);
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    if (!this.handshaken) {
      // 握手帧：回 ACK 让恒等通道转 transport。
      if (data.length === HELLO.length && data[0] === HELLO[0] && data[1] === HELLO[1]) {
        this.handshaken = true;
        this.emit(HELLO_ACK);
      }
      return;
    }
    let msg: unknown;
    try { msg = JSON.parse(new TextDecoder().decode(data)); }
    catch { return; } // 演示里不该出现，出现了也不能崩
    this.opts.onFrame(msg);
  }

  /** 假 agent 反向推帧。 */
  push(msg: unknown): void {
    if (this.closed || !this.handshaken) return;
    this.emit(new TextEncoder().encode(JSON.stringify(msg)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  private emit(bytes: Uint8Array): void {
    // 复制到独立的 ArrayBuffer：Connection 会读 ev.data 的 byteLength 做流量
    // 记账（connection.ts:379），共享底层 buffer 会算错。
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    this.onmessage?.({ data: buf });
  }
}
