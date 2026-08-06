// 「回前台后终端无法上翻」的取证探针（需求 3，12 期）。
//
// 这个 bug 偶现、且只在真手机从后台回来时发作——正是手边没有电脑、开不了
// devtools 的场景。agent 跑在用户自己机器上且 stdout 已落盘，所以让 App 在回
// 前台时发一条快照回去，把「偶现，抓不到」变成「复现后去日志里翻」。与
// atlas-probe.ts 同一套思路和同一套防御规则。
//
// 头号怀疑（**不是结论**）：xterm 6 的 Viewport._sync() 这样算滚动高度——
//     scrollHeight = cell.height × buffer.lines.length
// 若回前台那刻 cell.height 被测成 0/NaN（字体未就绪、IntersectionObserver 把
// 渲染器判为 paused 导致尺寸没刷新），scrollHeight 就塌成 0：缓冲区里明明有几
// 百行，滚动容器却认为无处可滚，而重建终端会重新测量字符尺寸——与「得关掉
// tab 重新打开才恢复」吻合。
//
// 快照同时覆盖相反假设：若 bufferLength 本身就很小，那是缓冲区真被清空了，
// 与尺寸无关。埋点的价值在于能同时否定两边，而不是给怀疑找证据。
//
// 访问 xterm 内部是刻意的——这些量没有公开 API。全程 optional-chain + try/catch，
// 上游结构变动只会得到一份残缺报告，绝不影响终端本身。
export interface ScrollSnapshot {
  /** "normal" | "alternate" | "unknown"。alt buffer 本就没有 scrollback。 */
  bufferType: string;
  /** 缓冲区总行数。很小 = 内容真没了；很大而滚不动 = 尺寸问题。 */
  bufferLength: number;
  /** 视口上方的滚动行数上限。 */
  baseY: number;
  /** 当前视口所在行。 */
  ydisp: number;
  rows: number;
  cols: number;
  /** 单元格高度（CSS px）。**核心怀疑点**：0 会让 scrollHeight 整个塌掉。 */
  cellHeight: number;
  /** 渲染画布高度（CSS px）。 */
  canvasHeight: number;
  /** 滚动的真实账本，取自 Viewport._scrollableElement（虚拟化滚动，不在 DOM 上）。 */
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** 读不到的数值统一用它，必须与真实的 0 可区分。 */
const UNREAD = -1;

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : UNREAD;

/**
 * 拍下一份滚动状态。永不抛。
 *
 * `term` 是 xterm 的 Terminal。按 unknown 收：这是取证代码，调用方不该为了
 * 埋点去满足类型。
 */
export function snapshotScroll(term: unknown): ScrollSnapshot {
  const snap: ScrollSnapshot = {
    bufferType: "unknown",
    bufferLength: UNREAD, baseY: UNREAD, ydisp: UNREAD,
    rows: UNREAD, cols: UNREAD,
    cellHeight: UNREAD, canvasHeight: UNREAD,
    scrollHeight: UNREAD, scrollTop: UNREAD, clientHeight: UNREAD,
  };
  try {
    const t = term as {
      rows?: number; cols?: number;
      buffer?: { active?: { type?: string; length?: number; baseY?: number; viewportY?: number } };
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number }; canvas?: { height?: number } } } } };
    } | null | undefined;

    const active = t?.buffer?.active;
    if (typeof active?.type === "string") snap.bufferType = active.type;
    snap.bufferLength = num(active?.length);
    snap.baseY = num(active?.baseY);
    snap.ydisp = num(active?.viewportY);
    snap.rows = num(t?.rows);
    snap.cols = num(t?.cols);

    const css = t?._core?._renderService?.dimensions?.css;
    snap.cellHeight = num(css?.cell?.height);
    snap.canvasHeight = num(css?.canvas?.height);
  } catch {
    // 残缺报告优于没有报告；字段保持 UNREAD。
  }
  try {
    // xterm 6 把滚动虚拟化了：.xterm-scrollable-element 没有 overflow 规则，
    // 只是 .xterm-screen 加两条自绘滚动条的定位壳，它的 scrollHeight/scrollTop
    // 是**恒定常量**（实测：300 行 scrollback 下恒为 360/0/360，向上翻 100 行
    // 也纹丝不动）。真实账本在 Viewport._scrollableElement 里 —— Viewport._sync()
    // 把 cell.height × lines.length 喂给它的 setScrollDimensions()，从不写 DOM。
    //
    // 读错地方不是「少一条线索」而是**假阳性**：常量恰好长成
    // scrollHeight === clientHeight && scrollTop === 0，也就是「滚动容器认为无处
    // 可滚」的教科书形态，会让读日志的人把头号怀疑判为坐实。
    const sd = (term as {
      _core?: { _viewport?: { _scrollableElement?: { getScrollDimensions?(): { scrollHeight?: number; scrollTop?: number; height?: number } } } };
    } | null | undefined)?._core?._viewport?._scrollableElement?.getScrollDimensions?.();
    snap.scrollHeight = num(sd?.scrollHeight);
    snap.scrollTop = num(sd?.scrollTop);
    snap.clientHeight = num(sd?.height); // Scrollable 管视口高度叫 height
  } catch {
    // 同上：残缺报告优于没有报告。
  }
  return snap;
}

/** 一行日志。与 atlas-probe 的 formatSnapshot 排版风格保持一致。 */
export function formatScrollSnapshot(tag: string, s: ScrollSnapshot): string {
  return (
    `[scroll:${tag}] buf=${s.bufferType} len=${s.bufferLength} baseY=${s.baseY} ydisp=${s.ydisp}` +
    ` size=${s.cols}x${s.rows} cellH=${s.cellHeight} canvasH=${s.canvasHeight}` +
    ` scrollH=${s.scrollHeight} scrollTop=${s.scrollTop} clientH=${s.clientHeight}`
  ).replace(/[\r\n]+/g, " ");
}
