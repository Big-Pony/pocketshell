import { test, expect, vi } from "vitest";
import { installJsErrorHook, type JsErrorWindow } from "./js-error-hook";

// 采集/清洗/限流三条契约的纯单元测试：window 用替身注入，事件手动派发。

const fakeWindow = () => {
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  const w: JsErrorWindow & { fire: (type: string, e: unknown) => void } = {
    addEventListener: (t, cb) => handlers.set(t, [...(handlers.get(t) ?? []), cb as (e: unknown) => void]),
    removeEventListener: (t, cb) =>
      handlers.set(t, (handlers.get(t) ?? []).filter((h) => h !== cb)),
    fire: (t, e) => { for (const h of handlers.get(t) ?? []) h(e); },
  };
  return w;
};

test("error 事件采出 message/stack/source", () => {
  const w = fakeWindow();
  const report = vi.fn();
  installJsErrorHook(report, {}, w);
  w.fire("error", {
    message: "boom",
    filename: "http://x/app.js", lineno: 12, colno: 34,
    error: { stack: "Error: boom\n    at f (app.js:12:34)" },
  });
  expect(report).toHaveBeenCalledTimes(1);
  const r = report.mock.calls[0][0];
  expect(r.message).toBe("boom");
  expect(r.source).toBe("http://x/app.js:12:34");
  expect(r.stack).toContain("Error: boom");
  // 栈被单行化
  expect(r.stack).not.toContain("\n");
});

test("unhandledrejection 采出 reason 的 message 与 stack", () => {
  const w = fakeWindow();
  const report = vi.fn();
  installJsErrorHook(report, {}, w);
  w.fire("unhandledrejection", { reason: new Error("async boom") });
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0][0].message).toBe("unhandledrejection: async boom");
  expect(report.mock.calls[0][0].stack).toContain("async boom");
});

test("同一条消息最多报 3 次，之后静默", () => {
  const w = fakeWindow();
  const report = vi.fn();
  installJsErrorHook(report, {}, w);
  for (let i = 0; i < 6; i++) w.fire("error", { message: "loop boom" });
  expect(report).toHaveBeenCalledTimes(3);
});

test("总量封顶 30 条", () => {
  const w = fakeWindow();
  const report = vi.fn();
  installJsErrorHook(report, {}, w);
  for (let i = 0; i < 40; i++) w.fire("error", { message: `boom-${i}` });
  expect(report).toHaveBeenCalledTimes(30);
});

test("消息与栈封顶截断", () => {
  const w = fakeWindow();
  const report = vi.fn();
  installJsErrorHook(report, {}, w);
  w.fire("error", { message: "x".repeat(500), error: { stack: "y".repeat(3000) } });
  const r = report.mock.calls[0][0];
  expect(r.message.length).toBe(300);
  expect(r.stack!.length).toBe(1500);
});

test("report 回调抛异常不外溢，后续事件照常采集", () => {
  const w = fakeWindow();
  let n = 0;
  const report = vi.fn(() => { n++; if (n === 1) throw new Error("report boom"); });
  installJsErrorHook(report, {}, w);
  w.fire("error", { message: "one" });
  w.fire("error", { message: "two" });
  expect(report).toHaveBeenCalledTimes(2);
});

test("卸载后不再采集", () => {
  const w = fakeWindow();
  const report = vi.fn();
  const off = installJsErrorHook(report, {}, w);
  off();
  w.fire("error", { message: "after off" });
  expect(report).not.toHaveBeenCalled();
});

test("畸形事件不抛：空对象、无 message、字符串 reason", () => {
  const w = fakeWindow();
  const report = vi.fn();
  installJsErrorHook(report, {}, w);
  w.fire("error", {});
  w.fire("error", null);
  w.fire("unhandledrejection", { reason: "plain string" });
  expect(report).toHaveBeenCalledTimes(3);
  expect(report.mock.calls[2][0].message).toBe("unhandledrejection: plain string");
});
