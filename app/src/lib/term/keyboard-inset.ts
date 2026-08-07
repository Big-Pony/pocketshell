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
