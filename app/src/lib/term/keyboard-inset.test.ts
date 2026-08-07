import { test, expect } from "vitest";
import { keyboardHeight, isKeyboardOpen, visibleHeightBelow, shouldRecenterCursor } from "./keyboard-inset";

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

// ---------------------------------------------------------------------------
// shouldRecenterCursor（十三期回归修复）：什么时候才该把光标滚回视野。
//
// 真机 bug：编辑态下滑到文件最底部会自动弹回顶部，读态没有。根因是
// fitViewport() 无条件 scrollIntoView(光标)，而光标在没点过正文时停在
// 位置 0（文件开头）。Android Chrome 里嵌套滚动条到底会把滚动链给页面，
// URL 栏收放导致 innerHeight 变化 → resize → fitViewport → 滚回光标 = 顶部。
//
// 这个动作**只该在编辑区变矮时**做（键盘弹起遮住光标），变高或没变时
// 用户正在阅读，抢滚动就是劫持。
// ---------------------------------------------------------------------------

test("编辑区变矮（键盘弹起遮住光标）→ 需要把光标滚回视野", () => {
  expect(shouldRecenterCursor(744, 444)).toBe(true);
});

test("编辑区变高（键盘收起）→ 不抢滚动", () => {
  // 用户可能正滚在文件中间读代码，此时把他弹回光标处是劫持。
  expect(shouldRecenterCursor(444, 744)).toBe(false);
});

test("高度没变 → 不抢滚动（这正是真机弹回顶部的那一下）", () => {
  // Android URL 栏收放会触发 resize，但编辑区高度可能纹丝不动。
  expect(shouldRecenterCursor(744, 744)).toBe(false);
});

test("首次布局（上一次高度未知）→ 不抢滚动", () => {
  // 挂载时 CM 自己会把光标放好，这里再抢一次没有意义。
  expect(shouldRecenterCursor(undefined, 744)).toBe(false);
});

test("变矮但幅度极小 → 不抢滚动（容差 8px，防抖动误触发）", () => {
  // 移动端浏览器 UI 的像素级抖动不该被当成键盘弹起。
  expect(shouldRecenterCursor(744, 740)).toBe(false);
});

test("变矮超过容差 → 需要滚回视野", () => {
  expect(shouldRecenterCursor(744, 735)).toBe(true);
});
