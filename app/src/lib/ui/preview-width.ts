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

/**
 * 顺序即底部弹层里的显示顺序。px 取常见响应式断点。
 *
 * `icon` 是 24×24 线性图标的路径集合，渲染时套 BottomBar 同款 <svg> 外壳
 * （fill:none / stroke:currentColor / stroke-width:2）。
 *
 * 为什么不用字符图标：初版按钮写的是 `▭`（U+25AD），两处翻车——内置的 5 套
 * 等宽字体里有 4 套（含默认的 maple-mono）压根没有这个字形，得掉进系统兜底
 * 字体去渲染，各家安卓的粗细与基线都不一样；而且它本身就是个没有特征的空心
 * 方块，三个档位共用它等于图标不传递任何信息。BottomBar 早先把 `▶ 🗀 ⌨ ⚡ ⚙`
 * 换成内联 SVG 正是同一个原因。
 *
 * 三个图标按**宽度**区分（手机 6 → 平板 12 → 桌面 20），一眼能看出选中的是哪档。
 */
export const PREVIEW_WIDTHS: { id: PreviewWidthId; px: number; icon: string[] }[] = [
  {
    id: "phone",
    px: 390,
    icon: ["M9 2h6a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z", "M11 19h2"],
  },
  {
    id: "tablet",
    px: 768,
    icon: ["M6 2h12a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z", "M10 19h4"],
  },
  {
    id: "desktop",
    px: 1280,
    icon: ["M3 4h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z", "M8 21h8", "M12 17v4"],
  },
];

/** 当前档位的图标路径。找不到时回落手机档——与 widthPxOf 的兜底方向一致。 */
export function iconOf(id: PreviewWidthId): string[] {
  return (PREVIEW_WIDTHS.find((w) => w.id === id) ?? PREVIEW_WIDTHS[0]).icon;
}

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
