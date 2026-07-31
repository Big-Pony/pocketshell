import { test, expect, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import StatusBar from "./StatusBar.svelte";

// 手势（拖拽调分区 / 双击全屏）是从 App.svelte 搬到这个组件的既有行为，
// 这些用例是搬迁的回归保护：任何一条挂了都说明手势在迁移中丢了。

const noop = () => {};
function mount(props: Record<string, unknown> = {}) {
  return render(StatusBar, {
    props: { onDown: noop, onMove: noop, onUp: noop, ...props },
  });
}
// jsdom 没有 PointerEvent 构造器。指针事件在 DOM 层就是带 pointerId 的 MouseEvent，
// 组件只读事件类型与坐标，用 MouseEvent 打过去等价。
function pointer(el: Element, type: "pointerdown" | "pointermove" | "pointerup") {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
}
function bar(c: ReturnType<typeof mount>): HTMLElement {
  const el = c.container.querySelector(".bar");
  if (!el) throw new Error("status bar not rendered");
  return el as HTMLElement;
}

beforeEach(() => localStorage.clear());

test("pointer down/move/up reach the drag handlers App passes in", () => {
  const seen: string[] = [];
  const c = mount({
    onDown: () => seen.push("down"),
    onMove: () => seen.push("move"),
    onUp: () => seen.push("up"),
  });
  const el = bar(c);
  pointer(el, "pointerdown");
  pointer(el, "pointermove");
  pointer(el, "pointerup");
  expect(seen).toEqual(["down", "move", "up"]);
});

test("the double-tap that toggles fullscreen arrives as two separate downs", () => {
  // 全屏切换的判定（两次 down 间隔 <300ms）住在 App 的 onDividerDown 里，
  // 组件的职责就是把每一次 down 都原样递上去，不吞、不合并。
  let downs = 0;
  const c = mount({ onDown: () => downs++ });
  const el = bar(c);
  pointer(el, "pointerdown");
  pointer(el, "pointerdown");
  expect(downs).toBe(2);
});

test("the bar is a separator with a describing label", () => {
  const c = mount();
  const el = bar(c);
  expect(el.getAttribute("role")).toBe("separator");
  expect(el.getAttribute("aria-label")).toContain("双击");  // vitest 固定 zh
});

test("the bar keeps touch-action:none so a drag isn't eaten by native scrolling", () => {
  // 没有 touch-action:none，纵向拖拽会被浏览器解析成页面滚动，拖拽调分区
  // 当场失效——这是手势能用的前提，不能被顺手删掉。
  // vitest 这套环境不注入组件样式（document.styleSheets 恒为空），运行时
  // 断言无从下手，所以直接检查源文件里这条声明还在。真实渲染效果由浏览器
  // 走查与真机验收把关。
  const css = readFileSync(resolve(__dirname, "./StatusBar.svelte"), "utf8");
  const barBlock = css.slice(css.indexOf("\n  .bar {"), css.indexOf("\n  .grp {"));
  expect(barBlock).toContain("touch-action: none");
});

// ---- 显示规则 ----

test("shows branch, latency and download rate when everything is available", () => {
  const c = mount({ branch: "main", dirty: true, latency: 42, rxBytes: 12 * 1024, elapsedMs: 1000 });
  expect(c.container.textContent).toContain("main*");
  expect(c.container.textContent).toContain("42ms");
  expect(c.container.textContent).toContain("↓12KB/s");
});

test("no git repo hides the branch group entirely — no placeholder", () => {
  const c = mount({ branch: "", latency: 42, rxBytes: 0, elapsedMs: 1000 });
  expect(c.container.querySelector(".branch")).toBeNull();
  expect(c.container.textContent).not.toContain("--");
});

test("offline blanks latency and throughput but keeps the bar (and its grip) alive", () => {
  const c = mount({ branch: "main", latency: 42, rxBytes: 9999, elapsedMs: 1000, online: false });
  expect(c.container.textContent).not.toContain("42ms");
  expect(c.container.textContent).not.toContain("KB/s");
  expect(c.container.querySelector(".grip")).not.toBeNull();  // 手势目标必须还在
});

test("idle shows 0KB/s rather than vanishing, so the bar doesn't jitter", () => {
  const c = mount({ rxBytes: 0, elapsedMs: 1000 });
  expect(c.container.textContent).toContain("↓0KB/s");
});

// ---- 首次提示 ----

test("the fullscreen tip shows once and is gone after using the bar", async () => {
  const c = mount();
  expect(c.container.querySelector(".tip")).not.toBeNull();
  pointer(bar(c), "pointerdown");
  await tick();
  expect(c.container.querySelector(".tip")).toBeNull();
  // 换一个实例（模拟下次打开）——标记已存，不再提示
  expect(mount().container.querySelector(".tip")).toBeNull();
});

test("dismissing the tip with × does not start a drag", async () => {
  let downs = 0;
  const c = mount({ onDown: () => downs++ });
  const x = c.container.querySelector(".tip-x") as HTMLElement;
  pointer(x, "pointerdown");
  await tick();
  expect(downs).toBe(0);
  expect(c.container.querySelector(".tip")).toBeNull();
});

// ---- AI 上下文用量（跑 AI 时右组换成 token） ----

test("有 token 数据时显示 token，隐藏延迟与吞吐", () => {
  const c = mount({
    branch: "main", latency: 38, rxBytes: 1024, elapsedMs: 1000, online: true,
    ctxUsed: 142000, ctxTotal: 1000000,
  });
  expect(c.container.textContent).toContain("142k/1M · 14%");
  expect(c.container.textContent).not.toContain("38ms");
  expect(c.container.textContent).not.toContain("KB/s");
});

test("无 token 数据时维持原有的延迟与吞吐显示", () => {
  const c = mount({
    branch: "main", latency: 38, rxBytes: 1024, elapsedMs: 1000, online: true,
  });
  expect(c.container.textContent).toContain("38ms");
  expect(c.container.textContent).not.toContain("·");
});

test("断线时不显示 token（与延迟吞吐同规则）", () => {
  const c = mount({
    branch: "main", latency: 38, rxBytes: 0, elapsedMs: 1000, online: false,
    ctxUsed: 142000, ctxTotal: 1000000,
  });
  expect(c.container.textContent).not.toContain("142k");
});

test("只有已用没有总量时也显示（claude 未接 statusLine 的路径）", () => {
  const c = mount({ latency: 38, rxBytes: 1024, elapsedMs: 1000, online: true, ctxUsed: 63476 });
  expect(c.container.textContent).toContain("63k");
  expect(c.container.textContent).not.toContain("38ms");
});
