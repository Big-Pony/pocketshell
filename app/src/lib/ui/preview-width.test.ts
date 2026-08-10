import { describe, expect, it } from "vitest";
import { PREVIEW_WIDTHS, widthPxOf, scaleFor, iconOf } from "./preview-width";

describe("预览宽度档位", () => {
  it("三档顺序固定为 手机/平板/桌面", () => {
    expect(PREVIEW_WIDTHS.map((w) => w.id)).toEqual(["phone", "tablet", "desktop"]);
  });

  it("档位宽度取常见断点值", () => {
    expect(widthPxOf("phone")).toBe(390);
    expect(widthPxOf("tablet")).toBe(768);
    expect(widthPxOf("desktop")).toBe(1280);
  });

  // 初版按钮用字符 `▭`（U+25AD）当图标，两处翻车：内置 5 套等宽字体里 4 套
  // （含默认的 maple-mono）没有这个字形，掉进系统兜底字体渲染成豆腐块；
  // 且它本身是个无特征方块，三档共用等于图标不传信息。BottomBar 早先把
  // `▶ 🗀 ⌨ ⚡ ⚙` 换成内联 SVG 是同一个教训。这两条锁死不许回潮。
  it("图标是 SVG 路径而非字符——字体缺字形会渲染成豆腐块", () => {
    for (const w of PREVIEW_WIDTHS) {
      expect(w.icon.length).toBeGreaterThan(0);
      // 合法的 path d 以移动指令开头；字符图标不可能满足
      for (const d of w.icon) expect(d).toMatch(/^[Mm]/);
    }
  });

  it("三档图标各不相同——否则按钮无法表达当前选中哪档", () => {
    const keys = PREVIEW_WIDTHS.map((w) => w.icon.join("|"));
    expect(new Set(keys).size).toBe(PREVIEW_WIDTHS.length);
  });

  it("iconOf 取到对应档位的图标", () => {
    expect(iconOf("desktop")).toEqual(PREVIEW_WIDTHS[2].icon);
  });

  // 非法 id 回落手机档而不是抛错/返回空数组：空数组会渲染出一个没有任何
  // 路径的 <svg>，即一块看不见的空白，比回落到错误档位更难排查。
  it("iconOf 遇到非法档位回落手机档", () => {
    expect(iconOf("nope" as never)).toEqual(PREVIEW_WIDTHS[0].icon);
  });
});

describe("scaleFor", () => {
  it("可用宽度足够时不缩放", () => {
    expect(scaleFor(390, 390)).toBe(1);
    expect(scaleFor(390, 500)).toBe(1);
  });

  // 桌面档在 390px 屏上：390/1280 ≈ 0.3047，整页可见但字很小。
  // 这正是需求要的——用户看的是"布局对不对"，不是读正文。
  it("档位宽于屏幕时按比例缩小", () => {
    expect(scaleFor(1280, 390)).toBeCloseTo(390 / 1280, 6);
    expect(scaleFor(768, 390)).toBeCloseTo(390 / 768, 6);
  });

  // 容器测宽在挂载前/隐藏时可能拿到 0，不能让 scale 变成 0 或 NaN——
  // scale:0 会让 iframe 彻底不可见且无法恢复（用户只看到空白，无从判断）。
  it("可用宽度为 0 或负数时回落为 1", () => {
    expect(scaleFor(1280, 0)).toBe(1);
    expect(scaleFor(1280, -5)).toBe(1);
  });

  it("档位宽度非法时回落为 1", () => {
    expect(scaleFor(0, 390)).toBe(1);
    expect(scaleFor(Number.NaN, 390)).toBe(1);
  });
});
