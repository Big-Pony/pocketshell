import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/svelte";
import Terminal from "./Terminal.svelte";

// 回前台自动上报图集状态（docs/bug/终端显示异常2）。
//
// 为什么必须是自动上报而不是 console：这个 bug 只在真机从后台切回来时偶现，
// 而这个 App 的使用场景恰恰是「手边没有电脑」——要用户在现场连 devtools 抄日志
// 是不可能的。agent 就跑在用户自己的机器上、stdout 已由 launchd 落盘，所以让
// 前端每次回前台顺手发一条，复现之后直接去日志里翻。
//
// jsdom 没有 WebGL，所以这里 snapshotAtlas 必然返回 hasRenderer:false。这不影响
// 本测试要钉的契约：**回前台就上报**，且上报失败不能影响任何东西。图集字段本身
// 的取值由 atlas-probe.test.ts 覆盖。
function stubConn(rpc: ReturnType<typeof vi.fn>) {
  return {
    onOutput: () => () => {},
    onInput: () => () => {},
    attach: () => {},
    resize: () => {},
    rpc,
  } as any;
}

function okRpc() {
  return vi.fn().mockResolvedValue({ data: "", currentCommand: "", alternateOn: false, isShell: true });
}

const diagCalls = (rpc: ReturnType<typeof vi.fn>) =>
  rpc.mock.calls.filter((c: unknown[]) => c[0] === "diag.report");

let origMatchMedia: any;
let origVisibility: PropertyDescriptor | undefined;
beforeAll(() => {
  origMatchMedia = window.matchMedia;
  const mql = { matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} };
  window.matchMedia = vi.fn().mockReturnValue(mql);
  origVisibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterAll(() => {
  window.matchMedia = origMatchMedia;
  if (origVisibility) Object.defineProperty(Document.prototype, "visibilityState", origVisibility);
});

test("reports the atlas state to the agent every time the app returns to the foreground", async () => {
  const rpc = okRpc();
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-diag", active: true } });
  await new Promise((r) => setTimeout(r, 0));
  rpc.mockClear();

  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 0));

  const calls = diagCalls(rpc);
  expect(calls.length).toBe(1);
  const p = calls[0][1] as Record<string, unknown>;
  // tag 标出是哪个会话——多标签同时中招时要能分辨。
  expect(p.tag).toBe("s-diag");
  expect(p.kind).toBe("atlas");
  // 探针必须给出「有没有 WebGL 渲染器」，否则日志里分不清「图集是好的」和
  // 「压根没走 WebGL」。
  expect(p).toHaveProperty("hasRenderer");
});

test("a failing report never propagates — diagnostics must not break the session", async () => {
  const rpc = vi.fn().mockImplementation((method: string) => {
    if (method === "diag.report") return Promise.reject(new Error("rpc_timeout"));
    return Promise.resolve({ data: "", currentCommand: "", alternateOn: false, isShell: true });
  });
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-diag2", active: true } });
  await new Promise((r) => setTimeout(r, 0));

  const onRejection = vi.fn();
  window.addEventListener("unhandledrejection", onRejection);
  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 10));
  window.removeEventListener("unhandledrejection", onRejection);

  expect(diagCalls(rpc).length).toBe(1);
  expect(onRejection).not.toHaveBeenCalled();
});

test("stops reporting once the terminal is unmounted", async () => {
  const rpc = okRpc();
  const { unmount } = render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-diag3", active: true } });
  await new Promise((r) => setTimeout(r, 0));
  unmount();
  rpc.mockClear();

  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 0));

  expect(diagCalls(rpc).length).toBe(0);
});
