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

/** 重灌的触发来源。埋点按它区分路径，故障复现后可直接定位。 */
export type ReseedTrigger = "alt-normal" | "stash-dirty" | "resync";
