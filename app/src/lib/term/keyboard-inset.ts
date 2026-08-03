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
