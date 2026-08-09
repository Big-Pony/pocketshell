// 演示用的 WebSocketLike 替身。Connection 只认这 6 个成员（connection.ts:12），
// 故整个传输层可被这一个类顶替，而 Connection 一个字都不用改。
//
// send() 收到的是**明文**字节（因为通道是恒等的），直接 JSON.parse 交给
// DemoAgent；反向由 agent 调 push() 送回。
import { HELLO, HELLO_ACK } from "./identity-channel";
import type { WebSocketLike } from "../lib/net/connection";
import { unpackBinFrame, BIN_FRAME_MAGIC } from "../lib/net/binframe";

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
    // 二进制帧（首字节 0x00）：演示态不实现写操作，但编辑/上传按钮可达，
    // 真实客户端会把 fs.write / fs.uploadChunk 打包成二进制帧发过来。头里
    // 就是完整的 rpc 消息，blob 丢掉即可 —— DemoAgent 的 default 分支会回
    // demo_unsupported。**不能静默吞掉**：没有 response 就是转圈到超时。
    if (data.length > 0 && data[0] === BIN_FRAME_MAGIC) {
      const bf = unpackBinFrame(data);
      if (!bf) return;
      this.opts.onFrame(bf.header);
      return;
    }
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

  /**
   * 送一帧给 Connection。**必须异步**——真 WebSocket 绝不可能在 send() 的调用
   * 栈里就把回帧交出来，Connection 是按这个前提写的：
   *
   *   socket.onopen = () => {
   *     if (m1) socket.send(m1);                   // 我们同步回了 HELLO_ACK
   *     this.hsTimer = setTimeout(…, 5000);        // 握手超时定时器在这之后才装
   *   }
   *
   * 同步回帧会让 established 的 clearHsTimer() 跑在 hsTimer 还是 undefined 的
   * 时候，随后装上的那个 5 秒定时器就没人清了——到点 ws.close()，掉线、重连、
   * 再来一遍，周期约 8 秒（5s 超时 + ~0.5s 退避 + 2.5s 延迟 open）。表现是演示
   * 站每 8 秒自己断一次，且与访客有没有操作无关。
   *
   * 微任务足够：它在 onopen 整个同步段跑完之后才执行，定时器那时已经装好。
   */
  private emit(bytes: Uint8Array): void {
    // 复制到独立的 ArrayBuffer：Connection 会读 ev.data 的 byteLength 做流量
    // 记账（connection.ts:379），共享底层 buffer 会算错。
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    queueMicrotask(() => {
      if (this.closed) return; // 排队期间被关掉：已关的 socket 不该再喂数据
      this.onmessage?.({ data: buf });
    });
  }
}
