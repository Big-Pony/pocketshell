// 「终端被 resize 成十几列、历史被永久写窄」的根因防线（12 期真机 bug）。
//
// 真机现象：Claude Code 的历史输出只占屏幕左侧一小块。取证发现窄排版**已经烙进
// tmux 自己的 scrollback**——不是 xterm 画错，是 tmux 窗口真的被 resize 成了约 12 列。
//
// 根因（真实 Chromium 实测，非推断）：`display:none` 的元素不参与布局，
// `getComputedStyle(el).width` 于是把**声明值**原样吐回来——`.term` 写的是
// `width:100%`，拿到的就是字符串 `"100%"`。而 FitAddon 对它做 `parseInt`：
//
//     parseInt("100%", 10) === 100      // 单位被静默吃掉，当成 100 像素
//     cols = floor((100 - padding - scrollbar) / cellWidth) ≈ 9~12
//
// 实测对照：
//   | 状态                  | computed width | proposeDimensions |
//   | 可见                  | "390px"        | 41 x 29           |
//   | 隐藏（width:100%）    | "100%"         |  9 x 5            |
//   | 隐藏（width:390px）   | "390px"        | 41 x 29           |
//
// 致命之处在于 FitAddon 的 `Math.max(0, ...)` 完全挡不住：它防的是 NaN/负数，
// 而这里 parseInt 返回的是**一个看起来非常合理的正数 100**，没有任何「我在瞎猜」
// 的信号；`proposeDimensions()` 也不会返回 undefined（它只在 cell.width===0 时
// 才返回，而 cell 尺寸是缓存的，隐藏时依然是 9x17，那道门也过了）。
//
// **等待救不了**（实测把这条路封死）：同一个隐藏元素，等 2 帧 rAF、等 2000ms、
// 等 fonts.ready，结果全是 9x5 一动不动；唯一让数值变对的事件是「元素被显示」。
// `display:none` 不是「还没画」，是**永远不参与布局**——这是稳态，不是竞态。
//
// 为什么必须在源头挡住：坏尺寸不只是「显示错了」。tmux 只能 reflow **它自己折的
// 软折行**；而 Claude Code 读 winsize 后**自己算折行位置、把 \n 打进输出流**，
// 那是硬换行，tmux 无从还原（实测：`capture-pane -J` 也拼不回来）。也就是说，
// 一次错误的 resize 会让上游程序按错误宽度生成字节，**这份历史不可逆**。
//
// 所以这里的取舍是：**宁可不 resize，也不能用猜出来的尺寸去 resize**。

/** 一次尺寸测量的结果。数值单位是「字符格」。 */
export interface Dims { cols: number; rows: number }

/**
 * 宿主元素是否真的处在布局里、可以被测量。
 *
 * 判据用 `clientWidth > 0` 而不是 computed style：隐藏时 clientWidth 诚实地返回
 * **0**，而 0 是可判别的失败信号；computed style 返回的 `"100%"` 解析出 100，
 * 是个**假装合理的坏值**——这正是本 bug 的成因。
 *
 * 高度一并要求非零：只有宽度非零而高度为零的元素，rows 同样会被算成塌陷值。
 */
export function isMeasurable(host: { clientWidth?: number; clientHeight?: number } | null | undefined): boolean {
  return !!host && (host.clientWidth ?? 0) > 0 && (host.clientHeight ?? 0) > 0;
}

/**
 * 一个尺寸是否可信到能发给 PTY。
 *
 * 下限不是为了「好看」，是为了把塌陷值（个位数到十几列）与真实的窄屏区分开。
 * 真机最窄的手机竖屏在最大字号下也远宽于此；而实测到的塌陷值是 9~12 列。
 */
export const MIN_COLS = 20;
export const MIN_ROWS = 4;

export function isPlausible(d: Dims | null | undefined): boolean {
  if (!d) return false;
  const { cols, rows } = d;
  return (
    Number.isFinite(cols) && Number.isFinite(rows) &&
    cols >= MIN_COLS && rows >= MIN_ROWS
  );
}

// ── 兜底：记住最后一次「可信」的尺寸 ────────────────────────────────────────
//
// 用途不是替代测量，而是给**测量不可用**的场景一个比 80x24 更贴近本机的起点
// （例如新建会话时 agent 侧默认 80 列，而本机其实是 41 列）。
//
// 只写入可信值：塌陷值绝不能被记住，否则兜底本身会变成污染源。

const KEY = "pocketshell.lastGoodDims";

/** 记下一次可信尺寸。不可信则**原样丢弃**（这是兜底不被污染的前提）。 */
export function rememberDims(d: Dims, store?: Storage): void {
  if (!isPlausible(d)) return;
  try {
    (store ?? localStorage).setItem(KEY, JSON.stringify({ cols: d.cols, rows: d.rows }));
  } catch { /* 隐私模式下 localStorage 会抛；记不住只是少一个兜底，不影响主路径 */ }
}

/**
 * 取回上次的可信尺寸；没有、读不出、或存的是脏数据都返回 null。
 *
 * 校验用与写入同一套 `isPlausible`：localStorage 是用户可改的，旧版本也可能写过
 * 别的形状，读侧不能假设它干净。
 */
export function recallDims(store?: Storage): Dims | null {
  try {
    const raw = (store ?? localStorage).getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const { cols, rows } = v as { cols?: unknown; rows?: unknown };
    const d = { cols: Number(cols), rows: Number(rows) };
    return isPlausible(d) ? d : null;
  } catch {
    return null;
  }
}
