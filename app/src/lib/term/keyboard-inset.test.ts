import { test, expect } from "vitest";
import { keyboardHeight, isKeyboardOpen, visibleHeightBelow } from "./keyboard-inset";

test("keyboardHeight is layout height minus visual viewport bottom", () => {
  // 844 tall layout; keyboard shrinks visual viewport to 544 at offsetTop 0.
  expect(keyboardHeight({ innerHeight: 844, vvHeight: 544, vvOffsetTop: 0 })).toBe(300);
});

test("keyboardHeight is 0 when the visual viewport fills the layout", () => {
  expect(keyboardHeight({ innerHeight: 844, vvHeight: 844, vvOffsetTop: 0 })).toBe(0);
});

test("keyboardHeight never goes negative", () => {
  expect(keyboardHeight({ innerHeight: 844, vvHeight: 900, vvOffsetTop: 0 })).toBe(0);
});

test("isKeyboardOpen uses a threshold", () => {
  expect(isKeyboardOpen({ innerHeight: 844, vvHeight: 544, vvOffsetTop: 0 })).toBe(true);
  expect(isKeyboardOpen({ innerHeight: 844, vvHeight: 800, vvOffsetTop: 0 })).toBe(false);
});

// ---------------------------------------------------------------------------
// visibleHeightBelow（13 期需求 1）：元素顶部到「键盘上沿」的可见高度。
// 两平台量法不同，判据是 vkHeight 这个数据本身，而不是能力探测——
// Android 键盘收起时 vkHeight 归 0，两条路径结果本就一致，无需特判。
// ---------------------------------------------------------------------------

test("Android 键盘弹起（覆盖模式）：viewport 不收缩，靠 vkHeight 扣", () => {
  // 844 布局高；键盘 300 高但 visualViewport 仍报 844（overlaysContent=true）。
  // 编辑器顶部在 y=100 → 可见高度 = 844 - 100 - 300 = 444
  expect(visibleHeightBelow({
    top: 100, innerHeight: 844, vvHeight: 844, vvOffsetTop: 0, vkHeight: 300,
  })).toBe(444);
});

test("Android 键盘收起：vkHeight 为 0，与 iOS 分支同结果", () => {
  expect(visibleHeightBelow({
    top: 100, innerHeight: 844, vvHeight: 844, vvOffsetTop: 0, vkHeight: 0,
  })).toBe(744);
});

test("iOS 键盘弹起：viewport 收缩，vkHeight 恒为 0", () => {
  // 键盘把 visualViewport 压到 544 → 可见高度 = 0 + 544 - 100 = 444
  expect(visibleHeightBelow({
    top: 100, innerHeight: 844, vvHeight: 544, vvOffsetTop: 0, vkHeight: 0,
  })).toBe(444);
});

test("iOS 页面被顶起时算进 vvOffsetTop", () => {
  expect(visibleHeightBelow({
    top: 100, innerHeight: 844, vvHeight: 544, vvOffsetTop: 60, vkHeight: 0,
  })).toBe(504);
});

test("结果不低于 minHeight（默认 160）", () => {
  // 键盘几乎占满：844 - 700 - 800 是负数，必须被托到 160
  expect(visibleHeightBelow({
    top: 700, innerHeight: 844, vvHeight: 844, vvOffsetTop: 0, vkHeight: 800,
  })).toBe(160);
});

test("minHeight 可覆盖", () => {
  expect(visibleHeightBelow({
    top: 700, innerHeight: 844, vvHeight: 844, vvOffsetTop: 0, vkHeight: 800, minHeight: 80,
  })).toBe(80);
});
