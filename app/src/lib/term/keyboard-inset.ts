// Pure geometry for the IME floating composer: derive the on-screen keyboard's
// height from the visual viewport so a fixed-position composer can hug just
// above it. No DOM access — the component feeds live metrics in.
export interface ViewportMetrics {
  innerHeight: number;   // layout viewport height (window.innerHeight)
  vvHeight: number;      // visualViewport.height
  vvOffsetTop: number;   // visualViewport.offsetTop
}

// Pixels the on-screen keyboard occupies at the bottom of the layout viewport.
export function keyboardHeight(m: ViewportMetrics): number {
  return Math.max(0, m.innerHeight - (m.vvOffsetTop + m.vvHeight));
}

export function isKeyboardOpen(m: ViewportMetrics, thresholdPx = 120): boolean {
  return keyboardHeight(m) > thresholdPx;
}

// 元素顶部到「键盘上沿」之间还剩多少可见高度。
//
// 两平台的键盘对视口做的事**根本不同**，所以量法也必须不同：
//  - Android Chrome：Keyboard.svelte 设了 virtualKeyboard.overlaysContent = true，
//    键盘覆盖在内容上，visualViewport 尺寸**不变**。只能从布局视口里减去
//    键盘自身的高度（vkHeight）。
//  - iOS Safari 及其他：浏览器收缩 visual viewport，键盘占掉的部分已经不在
//    vvHeight 里了，直接量 visual viewport 的底边即可。
//
// 判据取 `vkHeight > 0` 而不是「是否支持 VirtualKeyboard API」：Android 上键盘
// 收起时 vkHeight 归 0，此时两条路径算出的结果本就一致；把判据落在数据上，
// 这个函数才能不碰 navigator 就完整单测。
export interface VisibleHeightInput {
  top: number;           // 元素顶部在布局视口中的 y（getBoundingClientRect().top）
  innerHeight: number;   // window.innerHeight
  vvHeight: number;      // visualViewport.height
  vvOffsetTop: number;   // visualViewport.offsetTop
  vkHeight: number;      // Android VirtualKeyboard 的 boundingRect.height；其余平台恒 0
  minHeight?: number;    // 下限，默认 160
}

export function visibleHeightBelow(m: VisibleHeightInput): number {
  const raw = m.vkHeight > 0
    ? m.innerHeight - m.top - m.vkHeight
    : m.vvOffsetTop + m.vvHeight - m.top;
  return Math.max(m.minHeight ?? 160, raw);
}

// 重新测量高度后，要不要把光标滚回视野？
//
// **只在编辑区变矮时要**——那意味着键盘刚弹起、可能正压在光标上。
// 变高（键盘收起）或没变时，用户多半正滚着读代码，抢滚动就是劫持。
//
// 这条判断是十三期的回归修复。原先 fitViewport() 无条件 scrollIntoView(光标)，
// 真机症状是「编辑态滑到文件最底部会自己弹回顶部，读态没有」：光标在没点过
// 正文时停在位置 0（文件开头），而 Android Chrome 里嵌套滚动条滚到边界会把
// 滚动链交给页面，URL 栏一收一放就改变 innerHeight → 触发 resize →
// fitViewport → 滚回光标 = 弹回顶部。加上 scrollPastEnd() 之后底部空白变多、
// 更容易滚到边界，于是这条既有隐患才浮出水面。
const RECENTER_TOLERANCE_PX = 8;

export function shouldRecenterCursor(prevHeight: number | undefined, nextHeight: number): boolean {
  // 首次布局：CM 挂载时自己会把光标放好，这里再抢一次没有意义。
  if (prevHeight === undefined) return false;
  // 容差防抖：移动端浏览器 UI 的像素级抖动不该被当成键盘弹起。
  return prevHeight - nextHeight > RECENTER_TOLERANCE_PX;
}
