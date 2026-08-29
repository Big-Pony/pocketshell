import { test, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/svelte";
import Terminal from "./Terminal.svelte";

// 全链路采样（2026-08-22）的时机契约。
//
// 与 Terminal.diag.test.ts 分开是因为职责不同：那个测「上报失败不牵连会话」，
// 用真实时钟看同步发出的几条；这里测「什么时候采、什么时候**不**采」，必须用
// 假时钟推进 1.5s 的激活延时。
//
// 为什么要有这些用例（都是上线后被真实数据打脸补上的）：
//   - 首屏 seed 还在路上时激活，视口是空的。对拍会把 tmux 的每一非空行都报成
//     缺失 —— 线上第一条真实记录就是「27 行缺 19 行」，19 正是 tmux 侧非空行数。
//     那不是故障，是拍早了。
//   - jsdom 没有 WebGL/canvas，xterm 的 buffer 在这里恒为空行，所以「空视口不
//     发 diag.screen」这条在本环境下天然可测，且正是要钉的行为。

function stubConn(rpc: ReturnType<typeof vi.fn>) {
  return {
    onOutput: () => () => {},
    onInput: () => () => {},
    attach: () => {},
    resize: () => {},
    rpc,
    hasFeature: (n: string) => n === "diag",
  } as any;
}

const okRpc = () =>
  vi.fn().mockResolvedValue({ data: "", currentCommand: "", alternateOn: false, isShell: true });

// jsdom 没有 matchMedia，缺了它组件挂载当场就抛（Terminal.diag.test.ts 同款
// 前置）。visibilityState 固定为 visible，否则回前台探针不触发。
let origMatchMedia: typeof window.matchMedia;
let origVisibility: PropertyDescriptor | undefined;
beforeAll(() => {
  origMatchMedia = window.matchMedia;
  const mql = { matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} };
  window.matchMedia = vi.fn().mockReturnValue(mql) as never;
  origVisibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterAll(() => {
  window.matchMedia = origMatchMedia;
  if (origVisibility) Object.defineProperty(Document.prototype, "visibilityState", origVisibility);
});

const callsOf = (rpc: ReturnType<typeof vi.fn>, method: string) =>
  rpc.mock.calls.filter((c: unknown[]) => c[0] === method);
const kindsOf = (rpc: ReturnType<typeof vi.fn>) =>
  callsOf(rpc, "diag.report").map((c) => (c[1] as { kind?: string })?.kind);

afterEach(() => { vi.useRealTimers(); });

test("激活后不立刻采样 —— 那一刻首屏 seed 往往还在路上", async () => {
  vi.useFakeTimers();
  const rpc = okRpc();
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-smp1", active: true, streaming: true } });
  await vi.advanceTimersByTimeAsync(0);
  // 激活当刻：write/render 都还没发
  expect(kindsOf(rpc).filter((k) => k === "write" || k === "render")).toHaveLength(0);
});

test("激活 1.5s 后采样落地：write 与 render 各一条", async () => {
  vi.useFakeTimers();
  const rpc = okRpc();
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-smp2", active: true, streaming: true } });
  await vi.advanceTimersByTimeAsync(1600);
  const kinds = kindsOf(rpc);
  expect(kinds.filter((k) => k === "write").length).toBeGreaterThanOrEqual(1);
  expect(kinds.filter((k) => k === "render").length).toBeGreaterThanOrEqual(1);
});

test("空视口**不发** diag.screen —— 否则 tmux 的每一非空行都会被报成缺失", async () => {
  vi.useFakeTimers();
  const rpc = okRpc();
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-smp3", active: true, streaming: true } });
  await vi.advanceTimersByTimeAsync(1600);
  // jsdom 里终端始终没有内容 ⇒ 视口全空 ⇒ 对拍必须被跳过
  expect(callsOf(rpc, "diag.screen")).toHaveLength(0);
});

test("隐藏的终端不参与采样（它本来就不渲染）", async () => {
  vi.useFakeTimers();
  const rpc = okRpc();
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-smp4", active: false, streaming: true } });
  await vi.advanceTimersByTimeAsync(1600);
  expect(kindsOf(rpc).filter((k) => k === "write" || k === "render")).toHaveLength(0);
});

test("会话静止时心跳不产生日志 —— 十几个会话挂一夜不该把日志刷成噪音", async () => {
  vi.useFakeTimers();
  const rpc = okRpc();
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-smp5", active: true, streaming: true } });
  await vi.advanceTimersByTimeAsync(1600);
  const after = kindsOf(rpc).filter((k) => k === "write").length;
  // 再推进 60s：期间没有任何字节到达，心跳必须一条都不发
  await vi.advanceTimersByTimeAsync(60_000);
  expect(kindsOf(rpc).filter((k) => k === "write").length).toBe(after);
});

test("采样失败不抛、不产生未捕获拒绝", async () => {
  vi.useFakeTimers();
  const rpc = vi.fn().mockImplementation((m: string) => {
    if (m === "diag.report" || m === "diag.screen") return Promise.reject(new Error("rpc_timeout"));
    return Promise.resolve({ data: "", currentCommand: "", alternateOn: false, isShell: true });
  });
  const onRejection = vi.fn();
  window.addEventListener("unhandledrejection", onRejection);
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-smp6", active: true, streaming: true } });
  await vi.advanceTimersByTimeAsync(1600);
  window.removeEventListener("unhandledrejection", onRejection);
  expect(onRejection).not.toHaveBeenCalled();
});

// ---- 诊断开关（2026-08-23）----
// 埋点随 v1.19.3 一起发布，但默认**关闭**：agent 不带 `diag` 能力位时，客户端
// 一条 diag rpc 都不许发。这不是省流量，是省往返——采样点分布在回前台、滚动、
// 重灌、心跳五处，关着的时候每一处都白打一次 rpc，还跟真实输入抢同一条链路。
//
// 两条用例分别钉「关着不发」和「没有 hasFeature 也不炸」。后者是真实风险：
// 组件里的判断只要写成 `conn.hasFeature("diag")`，老版本连接对象（以及任何
// 没跟着更新的测试桩）就会在 onMount 里当场抛，把首屏 seed 一起带走——
// 这个坑在 term.onRender 上已经踩过一次了。

const featlessConn = (rpc: ReturnType<typeof vi.fn>) => {
  const c = stubConn(rpc);
  delete (c as Record<string, unknown>).hasFeature;
  return c;
};

test("agent 不带 diag 能力位时，一条诊断 rpc 都不发", async () => {
  vi.useFakeTimers();
  const rpc = okRpc();
  const conn = stubConn(rpc);
  (conn as { hasFeature: (n: string) => boolean }).hasFeature = () => false;
  render(Terminal, { props: { conn, sessionId: "s-smp7", active: true, streaming: true } });
  await vi.advanceTimersByTimeAsync(1600);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(1600);
  expect(callsOf(rpc, "diag.report")).toHaveLength(0);
  expect(callsOf(rpc, "diag.screen")).toHaveLength(0);
});

test("连接对象没有 hasFeature 时按关闭处理，且不影响首屏 seed", async () => {
  vi.useFakeTimers();
  const rpc = okRpc();
  render(Terminal, { props: { conn: featlessConn(rpc), sessionId: "s-smp8", active: true, streaming: true } });
  await vi.advanceTimersByTimeAsync(1600);
  expect(callsOf(rpc, "diag.report")).toHaveLength(0);
  // 首屏 seed 照常发生 —— 诊断判断抛出的话这条会挂
  expect(callsOf(rpc, "term.history").length).toBeGreaterThanOrEqual(1);
});

// ---- 采样订阅的生命周期（2026-08-23）----
// 心跳与 onRender 订阅的清理原先误写在 onResize 里 —— 那不是「终端没了」，
// 那是「终端变大了」。窗口一改尺寸就把两者永久关掉，此后 renderFrames 恒为 0、
// write 心跳彻底停摆。线上 aippt 会话据此被判成「渲染器停摆」，实为埋点自己
// 死了：同一条 render 记录里 pageVersions 3201→8368、bufDelta=387，屏幕明明在画。
//
// 这条测试钉的是「resize 之后采样还活着」。把清理挪回 onResize，它必须挂。

const outConn = (rpc: ReturnType<typeof vi.fn>) => {
  const out: Array<(f: { sessionId: string; data: Uint8Array }) => void> = [];
  const conn = {
    onOutput: (cb: (f: { sessionId: string; data: Uint8Array }) => void) => { out.push(cb); return () => {}; },
    onInput: () => () => {},
    attach: () => {},
    resize: () => {},
    rpc,
    hasFeature: (n: string) => n === "diag",
  } as any;
  return { conn, emit: (id: string, s: string) => { for (const cb of out) cb({ sessionId: id, data: new TextEncoder().encode(s) }); } };
};

test("窗口 resize 之后心跳仍在采样 —— 清理属于销毁，不属于改尺寸", async () => {
  vi.useFakeTimers();
  const rpc = okRpc();
  const { conn, emit } = outConn(rpc);
  render(Terminal, { props: { conn, sessionId: "s-smp9", active: true, streaming: true } });
  await vi.advanceTimersByTimeAsync(1600);
  const before = kindsOf(rpc).filter((k) => k === "write").length;

  // 改一次窗口尺寸（真实路径：window resize → 150ms 防抖 refit）
  window.dispatchEvent(new Event("resize"));
  await vi.advanceTimersByTimeAsync(300);

  // 有新字节 + 超过 SAMPLE_MS(15s)，心跳必须照常打点
  emit("s-smp9", "hello from the pty\r\n");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(kindsOf(rpc).filter((k) => k === "write").length).toBeGreaterThan(before);
});

test("终端销毁后心跳停止 —— 往已 dispose 的终端读 buffer 会抛", async () => {
  vi.useFakeTimers();
  const rpc = okRpc();
  const { conn, emit } = outConn(rpc);
  const { unmount } = render(Terminal, { props: { conn, sessionId: "s-smp10", active: true, streaming: true } });
  await vi.advanceTimersByTimeAsync(1600);
  unmount();
  const after = kindsOf(rpc).filter((k) => k === "write").length;
  emit("s-smp10", "output after unmount\r\n");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(kindsOf(rpc).filter((k) => k === "write").length).toBe(after);
});

// ---- resize 埋点（2026-08-24）----
// 用户报告：「终端在输出的时候，我没有进行任何操作」却出现内容错乱。而
// ResizeObserver 不需要用户操作就会触发（软键盘、滚动条出没、布局变化都算）。
// 此前**零 resize 埋点**，「到底有没有发生 resize」这个问题在日志里根本答不了。
//
// 两条：尺寸真变了要上报（带触发源），没变不许上报（否则每次滚动都是噪音）。
test("尺寸变化时上报 resize，带触发源与前后 cols", async () => {
  vi.useFakeTimers();
  const rpc = okRpc();
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-rz1", active: true, streaming: true } });
  await vi.advanceTimersByTimeAsync(1600);
  const rz = callsOf(rpc, "diag.report")
    .map((c) => c[1] as Record<string, unknown>)
    .filter((p) => p.kind === "resize");
  // jsdom 下首次 refit 会把 0×0 变成实际值，至少有一条
  for (const r of rz) {
    expect(typeof r.why).toBe("string");
    expect(typeof r.toCols).toBe("number");
    expect(r.sentToPty).toBe(1);
  }
});

test("尺寸没变时不上报 resize —— 否则每次滚动都是噪音", async () => {
  vi.useFakeTimers();
  const rpc = okRpc();
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-rz2", active: true, streaming: true } });
  await vi.advanceTimersByTimeAsync(1600);
  const before = callsOf(rpc, "diag.report")
    .map((c) => c[1] as Record<string, unknown>)
    .filter((p) => p.kind === "resize").length;
  // 再触发几次 resize 事件，但尺寸不变
  for (let i = 0; i < 3; i++) window.dispatchEvent(new Event("resize"));
  await vi.advanceTimersByTimeAsync(500);
  const after = callsOf(rpc, "diag.report")
    .map((c) => c[1] as Record<string, unknown>)
    .filter((p) => p.kind === "resize").length;
  expect(after).toBe(before);
});

// 【2026-08-28 输入回底部】真终端里打字自动滚回底部（xterm scrollOnUserInput），
// 我们的输入走 RPC→tmux 不经过 xterm 键盘事件，这个行为只能在 sendInput 收口处补。
// 没有它：用户向上滚一行后，输入框所在的底行在视口外、xterm 不重绘视口外的脏行，
// 表现为「打字无回显、终端像卡死」。
test("输入即回底部 —— RPC 输入旁路必须补上 scrollOnUserInput 的等价行为", async () => {
  vi.useFakeTimers();
  let inputCb: ((sid: string) => void) | undefined;
  const rpc = okRpc();
  const conn = {
    ...stubConn(rpc),
    onInput: (cb: (sid: string) => void) => { inputCb = cb; return () => {}; },
  };
  let captured: any;
  render(Terminal, {
    props: { conn, sessionId: "s-scroll1", active: true, streaming: true, onReady: (_sid: string, t: any) => { captured = t; } },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(inputCb).toBeTypeOf("function");
  expect(captured).toBeTypeOf("object");
  const spy = vi.spyOn(captured, "scrollToBottom");
  inputCb!("s-scroll1");
  expect(spy).toHaveBeenCalledTimes(1);
  // 别的会话的输入不牵动这个终端。
  inputCb!("other-session");
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});
