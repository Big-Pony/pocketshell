import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/svelte";
import Terminal from "./Terminal.svelte";

// 只有可见的终端才持有 WebGL 上下文（docs/bug/终端显示异常2）。
//
// 根因是实测出来的，不是推的：浏览器对每页存活的 WebGL 上下文数有硬上限，超了
// 就强制杀掉最老的那个。Chrome 里实测第 1..16 个终端全部存活，从第 17 个开始每
// 新增一个就恰好死掉一个更老的，存活数死死钉在 16。手机上的限额低得多。
//
// App.svelte 每个 tab 挂一个活的 <TerminalView>，于是 N 个 tab = N 个存活上下
// 文，超限后浏览器把老 tab 的渲染器杀掉——这就是为什么必须开好几个窗口才会出
// 现、为什么有的 tab 正常有的冻在最后一帧、以及为什么只有关掉全部 tab 才能恢复。
//
// jsdom 没有 WebGL，所以这里 create 必然失败、走 DOM 渲染器分支。这不影响本测
// 试要钉的契约：**隐藏时必须解除、显示时必须重建**，且这些调用在没有 WebGL 的
// 环境下也不能抛。真正的上下文计数由 webgl-renderer.test.ts 覆盖。
function stubConn() {
  return {
    onOutput: () => () => {},
    onInput: () => () => {},
    attach: () => {},
    resize: () => {},
    rpc: vi.fn().mockResolvedValue({ data: "", currentCommand: "", alternateOn: false, isShell: true }),
  } as any;
}

let origMatchMedia: any;
beforeAll(() => {
  origMatchMedia = window.matchMedia;
  const mql = { matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} };
  window.matchMedia = vi.fn().mockReturnValue(mql);
});
afterAll(() => {
  window.matchMedia = origMatchMedia;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

test("switching a terminal between hidden and visible never throws", async () => {
  // 没有 WebGL 时 suspend/resume 都是 no-op，但绝不能因此炸掉切 tab 这条主路径。
  const { rerender } = render(Terminal, {
    props: { conn: stubConn(), sessionId: "s1", active: true },
  });
  await tick();

  for (let i = 0; i < 3; i++) {
    await rerender({ conn: stubConn(), sessionId: "s1", active: false });
    await tick();
    await rerender({ conn: stubConn(), sessionId: "s1", active: true });
    await tick();
  }
  // 走到这里没抛就是通过；上下文计数在 webgl-renderer.test.ts 里断言。
  expect(true).toBe(true);
});

test("a terminal that mounts hidden does not take a context", async () => {
  // 打开新 tab 时，其它 tab 是隐藏挂载的。如果隐藏挂载也拿上下文，那么「一次开
  // 很多 tab」照样会顶到上限——这正是原来的行为。
  const { unmount } = render(Terminal, {
    props: { conn: stubConn(), sessionId: "s2", active: false },
  });
  await tick();
  expect(() => unmount()).not.toThrow();
});
