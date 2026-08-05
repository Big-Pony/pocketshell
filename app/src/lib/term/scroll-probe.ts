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
  /** 滚动容器的真实状态，直接取自 DOM——与上面 xterm 侧的账本对照着看。 */
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
 * `term` 是 xterm 的 Terminal，`host` 是挂载它的元素（用来找滚动容器）。
 * 两者都按 unknown 收：这是取证代码，调用方不该为了埋点去满足类型。
 */
export function snapshotScroll(term: unknown, host: unknown): ScrollSnapshot {
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
    // xterm 6 把可滚动区做成了 .xterm-scrollable-element（不再是 .xterm-viewport
    // 直接滚）。找不到就保持 -1，别猜别的元素——猜错会给出一份看似正常的假数据。
    const el = (host as { querySelector?(s: string): unknown } | null | undefined)
      ?.querySelector?.(".xterm-scrollable-element") as
      { scrollHeight?: number; scrollTop?: number; clientHeight?: number } | null | undefined;
    snap.scrollHeight = num(el?.scrollHeight);
    snap.scrollTop = num(el?.scrollTop);
    snap.clientHeight = num(el?.clientHeight);
  } catch {
    // 同上。
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
