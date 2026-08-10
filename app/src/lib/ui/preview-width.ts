// app/src/lib/ui/preview-width.ts
// HTML 预览的渲染宽度档位（14 期需求 1）。
//
// 为什么需要"宽度"这个旋钮而不是只做缩放：预览桌面端网页体验差的根因是
// **渲染宽度**——iframe 视口宽度等于手机屏宽，桌面站要么走响应式移动分支
// （看不到桌面的样子），要么横向溢出。`transform: scale()` 只放大像素，
// iframe 内部认为的视口宽度不变，所以单纯缩放解决不了这个问题。
//
// 两个旋钮独立：width 决定页面按多宽布局，scale 决定它在屏幕上占多大。

export type PreviewWidthId = "phone" | "tablet" | "desktop";

/** 顺序即底部弹层里的显示顺序。px 取常见响应式断点。 */
export const PREVIEW_WIDTHS: { id: PreviewWidthId; px: number }[] = [
  { id: "phone", px: 390 },
  { id: "tablet", px: 768 },
  { id: "desktop", px: 1280 },
];

export function widthPxOf(id: PreviewWidthId): number {
  return PREVIEW_WIDTHS.find((w) => w.id === id)?.px ?? 390;
}

/**
 * 算出把 `widthPx` 宽的内容塞进 `availPx` 可用宽度所需的缩放比。
 *
 * 恒 ≤ 1：**永不放大**。放大既没有信息增益（像素就那么多），又会让手机档
 * 在大屏上变得糊。
 *
 * 两处兜底都回落 1 而不是 0——容器在挂载前/隐藏时 `clientWidth` 为 0，
 * 若照算会得到 scale:0，iframe 彻底不可见且用户无从判断发生了什么。
 */
export function scaleFor(widthPx: number, availPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 1;
  if (!Number.isFinite(availPx) || availPx <= 0) return 1;
  return Math.min(1, availPx / widthPx);
}
