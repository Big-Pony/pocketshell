// 重灌 tmux 历史的纯逻辑。组件只做接线，决策全在这里 —— 同 pending-buffer.ts /
// fit-guard.ts 的既有约定（放在 .ts 里才能被 vitest 直接覆盖；tsc 只看 *.svelte
// 的 ambient 默认导出，组件里的具名导出对 typecheck 不可见）。
//
// 存在的理由（实测，非推断）：xterm 的 write() 是**异步入队**的（WriteBuffer 按
// 12ms 时间片解析），而 Terminal.reset() 是**同步**的、且完全不碰那个队列。
// xterm 上游在 CoreBrowserTerminal 的 reset() 注释里写得很清楚：
//
//     "Calling this directly from JS is synchronous but does not clear input
//      buffers and does not reset the parser, thus the terminal will continue
//      to apply pending input data. If you need in band reset consider using
//      DECSTR (soft reset) or RIS instead (hard reset, ESC c)."
//
// 也就是说 reset() 之前排队的实时字节会在 reset() **之后**被解析，然后与随后
// 写入的快照熔在一起。本机实测（真 xterm 6.1.0-beta.292，零网络延迟）：
//
//     write("p8"); reset(); write("rmissions\r\n")  →  "p8rmissions"
//     write("\x1bc" + "rmissions\r\n") 拼一次写      →  "rmissions"
//
// 左边那个字符串正是真机截图里的 `p8rmissions`（应为 bypass permissions）。
// 所以清空必须走**流内 RIS**，且必须与内容拼进同一次 write —— 拆成两次 write
// 虽然队列里也有序，但中间会插进实时帧，修复即失效。
const RIS = "\x1bc";

/**
 * 拼出一次重灌要写进 xterm 的完整字节串。
 *
 * capture-pane 的输出是 trim 过、以裸 \n 分隔的；xterm 跑在 convertEol:false 下，
 * 裸 \n 只下移一行、不回到第 0 列，直接写会渲染成对角线楼梯（`:q` 退出 vim 后
 * 尤其明显，因为那时没有实时重绘掩盖它）。所以统一规范成 \r\n。
 */
export function buildReseedPayload(data: string): string {
  return RIS + data.replace(/\r?\n/g, "\r\n");
}

/**
 * 代际闸门：一次重灌发起时领号，RPC 返回时验号，过期的整份丢弃。
 *
 * 这不是主修复（RIS 已经让「最后一次赢」成为确定性行为），而是廉价的正确性
 * 加固：RPC 可能乱序返回，没有这道闸旧快照就能赢过新快照。
 */
export class ReseedGate {
  private gen = 0;
  begin(): number {
    return ++this.gen;
  }
  isStale(gen: number): boolean {
    return gen !== this.gen;
  }
}

/**
 * 重灌的触发来源。埋点按它区分路径，故障复现后可直接定位。
 *
 * "seed" 是首屏那次（seedFromHistory），2026-08-18 补上。此前它**完全没有埋点**，
 * 而它才是「重进应用」的主路径 —— 日志里 82 条 reseed 全来自 resync/alt-normal，
 * 首屏空白这个用户实际报告的故障在日志里一个直接证据都没有。
 *
 * agent 侧 diag-report.ts 对 trigger 是「任意字符串过 oneLine」，不是枚举白名单，
 * 所以加值不需要动 agent。
 */
export type ReseedTrigger = "alt-normal" | "stash-dirty" | "resync" | "seed";

export interface ReseedReportInput {
  trigger: ReseedTrigger;
  /** RPC 往返耗时（ms）。量的是竞态窗口有多宽。 */
  rttMs: number;
  /** 本次快照是否因代际过期被整份丢弃。为真 = 并发确实发生了、且被拦下。 */
  discarded: boolean;
  snapshotBytes: number;
  /** await 期间到达的实时帧数与字节数 —— 旧实现下这些正是会被抹掉的内容。 */
  framesDuringAwait: number;
  bytesDuringAwait: number;
  bufferLenBefore: number;
  bufferLenAfter: number;
  /**
   * 失败原因（只放 Error.message / code，绝不放响应体）。成功时不传。
   *
   * 2026-08-18：此前 diag.report 位于 `await conn.rpc()` **之后**、且在同一个
   * try 内，外层是空 catch —— term.history 一旦超时，这次 reseed 不产生任何
   * 日志。于是所有量化都建立在幸存者样本上，越是故障严重的链路越不出现在日志里。
   *
   * `error` 已在 agent 白名单里（diag-report.ts 的 `if (typeof p.error === "string")`），
   * 所以补这条不需要动 agent 侧。
   */
  error?: string;
}

/**
 * 组装一次重灌的诊断上报体。
 *
 * 只放计数，不放任何终端内容 —— 这条日志用户可能直接贴进公开 issue。
 * agent 侧 diag-report.ts 是白名单制，字段名两边必须逐字对应，漂移是静默的
 * （字段被丢掉，日志里只是少几个数，什么都不报错）。
 */
export function buildReseedReport(input: ReseedReportInput): Record<string, unknown> {
  return {
    kind: "reseed",
    trigger: input.trigger,
    rttMs: input.rttMs,
    discarded: input.discarded,
    snapshotBytes: input.snapshotBytes,
    framesDuringAwait: input.framesDuringAwait,
    bytesDuringAwait: input.bytesDuringAwait,
    bufferLenBefore: input.bufferLenBefore,
    bufferLenAfter: input.bufferLenAfter,
    // 成功样本的形状保持不变：不传就不出现这个键，日志里一眼能分成败两类。
    ...(input.error ? { error: input.error } : {}),
  };
}

export interface RpcReportInput {
  method: string;
  rttMs: number;
  /** 实际上线字节（压缩后）。 */
  wireBytes: number;
  /** 压缩前字节；未压缩时与 wireBytes 相等。 */
  rawBytes: number;
  /** 分片数，1 = 单帧。 */
  chunks: number;
}

/**
 * 组装一次 rpc 的传输埋点。
 *
 * 只放计数与方法名，不放任何载荷内容 —— 这条日志用户可能直接贴进公开 issue。
 * agent 侧 diag-report.ts 是白名单制，字段名两边必须逐字对应，漂移是静默的。
 */
export function buildRpcReport(input: RpcReportInput): Record<string, unknown> {
  return {
    kind: "rpc",
    method: input.method,
    rttMs: input.rttMs,
    wireBytes: input.wireBytes,
    rawBytes: input.rawBytes,
    chunks: input.chunks,
  };
}

// ── term.history 的死线记账（2026-08-18，优先级 1a）──
//
// connection.ts 的 rpc 死线按「排在前面 + 自己」的字节数放大，但那只算**出站**
// 字节，除非调用方用 opts.expectBytes 显式告知响应体多大。全项目此前只有下载
// 路径（transfer.ts:281/332）在传，term.history 不传 —— 于是 8 个 tab 同时重进
// 时，8 个并发 history 与 1 个拿到**完全相同**的 10 秒死线：每个 lane 都以为自己
// 只排了两百来字节，而实际要等前面 7 份快照先排空。
//
// 这不是「保守裕度」，是与下载路径同一个 bug 的第二个实例（connection.ts:305-308
// 的注释自述过一次）。真机日志里 9283ms 那条 rtt 大概率就是被 10 秒死线截断的右端。
//
// 每行多少字节：真机 8 会话实测，压缩后 8~22KB / 原始 40~83KB（1000 行），
// base64 再膨胀 4/3 → 上线约 11~30KB，即 11~30 B/行。取 30 是这个区间的上沿，
// 因为**高估的代价远小于低估**：高估只是在健康链路上多给几秒宽限（死线本来就
// 只是「慢到这个程度也不该判死」的下界），低估则等于没修。
export const HISTORY_WIRE_BYTES_PER_LINE = 30;

/** term.history 响应体的字节估算。精度不重要，量级正确即可（见上方注释）。 */
export function historyExpectBytes(lines: number): number {
  if (!Number.isFinite(lines) || lines <= 0) return 0;
  return Math.floor(lines) * HISTORY_WIRE_BYTES_PER_LINE;
}

// ── 首屏 seed 的退避重试（2026-08-18，优先级 1b）──
//
// 旧实现的 catch 里只做 `conn.attach(sessionId)`（lastSeq=0，反而触发整环重放），
// finally 里 `seeding = false` 把进度提示关掉 —— 无重试、无提示、无埋点。
// 而此后三条重灌路径在该场景下**全部不触发**：alt-normal 因 appliedMode 初值就是
// "normal" 而永不发生；stash-dirty 在 87 条生产日志里出现 0 次；resync 要服务端主动
// 发。结果是**永久空白**，用户报告的正是「8 个 tab 重进全部空白，关掉重开才好」。
//
// 「关掉重开就好」这个现象本身就是证据：只有重新挂载能再走一次 seedFromHistory。
// 那就让它自己再走一次。
export const SEED_MAX_ATTEMPTS = 3;

/** 第 n 次失败后等多久再试（指数退避 + 上限）。attempt 从 0 开始。 */
export function seedRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 800 * Math.pow(3, Math.max(0, attempt)));
}

// ── 重灌载荷 + 窗口旁录的合并（2026-08-18，优先级 4）──
//
// reloadHistory 的 t0..t1 窗口（真机 rtt 中位 1931ms、最高 9283ms）里，PTY 输出
// 照常写进 xterm，然后 t1 到达的快照用 RIS 把它们清掉：这些字节**快照里没有**
// （拍摄时还没产生）、RIS 又抹掉 → 永久消失。丢的是时间中段，所以症状是
// 「中间几行消失」而不是「最新几行消失」。
//
// 核心洞察：**丢失的字节从来没离开过客户端**，只是被 RIS 抹了。所以不需要向
// 服务端再要一次（补发 attach(h.seq) 那条路已被证伪：connection.ts:840 的
// `if (subscribed || …) return` 在 seen 覆盖之后，重灌路径下帧发不出去但 seen
// 已被回退，且会形成 resync→重灌→attach→gap→resync 自激环）。窗口内的字节旁录
// 在本地，快照到达时接在后面重写一遍即可。
//
// 必须走**字节**而不是字符串：实时帧可能在一个多字节字符中间被切开，两帧各自
// decode 会各产生一个 U+FFFD，拼起来就是两个乱码方块（终端里中文很常见）。
// 而且 RIS + 快照 + 窗口三段**必须拼进同一次 write** —— 拆成两次虽然队列里也
// 有序，但中间会插进新的实时帧（见本文件顶部的实测记录）。
export function concatReseedWrite(payload: string, window: Uint8Array | null): string | Uint8Array {
  if (!window || window.byteLength === 0) return payload;
  const head = new TextEncoder().encode(payload);
  const out = new Uint8Array(head.byteLength + window.byteLength);
  out.set(head, 0);
  out.set(window, head.byteLength);
  return out;
}
