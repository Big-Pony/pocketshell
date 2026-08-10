import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/svelte";
import Skeleton from "./Skeleton.svelte";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("Skeleton 延迟显示", () => {
  // 关键设计：大量 RPC 在局域网下 50ms 就回来了，无差别显示骨架屏
  // 会变成闪烁——比没有更烦。延迟做在组件内部，接线处不必操心。
  it("300ms 之前什么都不渲染", () => {
    const { container } = render(Skeleton, { props: {} });
    expect(container.querySelector(".sk")).toBeNull();
    vi.advanceTimersByTime(299);
    expect(container.querySelector(".sk")).toBeNull();
  });

  it("超过 300ms 后渲染骨架", async () => {
    const { container } = render(Skeleton, { props: {} });
    vi.advanceTimersByTime(320);
    await Promise.resolve();
    expect(container.querySelector(".sk")).toBeTruthy();
  });

  it("delayMs=0 立即渲染（用于已知必然慢的场景）", async () => {
    const { container } = render(Skeleton, { props: { delayMs: 0 } });
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(container.querySelector(".sk")).toBeTruthy();
  });
});

describe("Skeleton 形状", () => {
  async function shown(props: Record<string, unknown>) {
    const r = render(Skeleton, { props: { ...props, delayMs: 0 } });
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    return r.container;
  }

  it("默认渲染 3 组", async () => {
    const c = await shown({});
    expect(c.querySelectorAll(".sk-row").length).toBe(3);
  });

  it("rows 控制组数", async () => {
    const c = await shown({ rows: 6 });
    expect(c.querySelectorAll(".sk-row").length).toBe(6);
  });

  // 三种 variant 的差别是形状不是颜色：list 是等宽条，tree 带缩进，
  // text 更细更密（模拟代码行）。用 data 属性暴露以便接线处按需选。
  it("variant 写进 data 属性", async () => {
    const c = await shown({ variant: "tree" });
    expect(c.querySelector(".sk")!.getAttribute("data-variant")).toBe("tree");
  });

  it("对读屏软件是 busy 状态而非一堆空 div", async () => {
    const c = await shown({});
    const el = c.querySelector(".sk")!;
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.getAttribute("aria-live")).toBe("polite");
  });
});
