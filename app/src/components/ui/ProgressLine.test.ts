import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/svelte";
import ProgressLine from "./ProgressLine.svelte";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function shown(props: Record<string, unknown> = {}) {
  const r = render(ProgressLine, { props: { delayMs: 0, ...props } });
  vi.advanceTimersByTime(1);
  await Promise.resolve();
  return r.container;
}

describe("ProgressLine", () => {
  it("300ms 之前什么都不渲染", () => {
    const { container } = render(ProgressLine, { props: {} });
    vi.advanceTimersByTime(299);
    expect(container.querySelector(".pl")).toBeNull();
  });

  it("不确定进度时走 indeterminate 模式", async () => {
    const c = await shown();
    const el = c.querySelector(".pl")!;
    expect(el.classList.contains("indet")).toBe(true);
    // 不确定进度不该谎报一个具体数值给读屏软件
    expect(el.getAttribute("aria-valuenow")).toBeNull();
  });

  it("有 value 时按比例推进并上报给读屏软件", async () => {
    const c = await shown({ value: 0.42 });
    const el = c.querySelector(".pl")! as HTMLElement;
    expect(el.classList.contains("indet")).toBe(false);
    expect(el.getAttribute("aria-valuenow")).toBe("42");
    const fill = c.querySelector(".pl-fill") as HTMLElement;
    expect(fill.style.width).toBe("42%");
  });

  it("value 越界被夹到 0..1", async () => {
    const over = await shown({ value: 1.8 });
    expect((over.querySelector(".pl-fill") as HTMLElement).style.width).toBe("100%");
    const under = await shown({ value: -3 });
    expect((under.querySelector(".pl-fill") as HTMLElement).style.width).toBe("0%");
  });

  it("是 progressbar 角色", async () => {
    const c = await shown();
    expect(c.querySelector(".pl")!.getAttribute("role")).toBe("progressbar");
  });
});
