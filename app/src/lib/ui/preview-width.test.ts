import { describe, expect, it } from "vitest";
import { PREVIEW_WIDTHS, widthPxOf, scaleFor } from "./preview-width";

describe("预览宽度档位", () => {
  it("三档顺序固定为 手机/平板/桌面", () => {
    expect(PREVIEW_WIDTHS.map((w) => w.id)).toEqual(["phone", "tablet", "desktop"]);
  });

  it("档位宽度取常见断点值", () => {
    expect(widthPxOf("phone")).toBe(390);
    expect(widthPxOf("tablet")).toBe(768);
    expect(widthPxOf("desktop")).toBe(1280);
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
