import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/svelte";
import Terminal from "./Terminal.svelte";
import { toB64 } from "../lib/bytes";

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
    detach: () => {},
    resize: () => {},
    rpc,
    hasFeature: (n: string) => n === "diag",
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
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-diag", active: true, streaming: true } });
  await new Promise((r) => setTimeout(r, 0));
  rpc.mockClear();

  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 0));

  // onVisible 现在并排发两条（atlas + scroll，见需求 3 埋点），各自 try/catch
  // 互不干扰——这里只看 atlas 那条,scroll 那条由它自己的测试覆盖。
  const calls = diagCalls(rpc).filter((c) => (c[1] as { kind?: string })?.kind === "atlas");
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
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-diag2", active: true, streaming: true } });
  await new Promise((r) => setTimeout(r, 0));

  const onRejection = vi.fn();
  window.addEventListener("unhandledrejection", onRejection);
  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 10));
  window.removeEventListener("unhandledrejection", onRejection);

  // 每一条上报都失败也不能互相牵连、更不能抛出未捕获拒绝：
  //   - 激活时的 scroll 快照（tag 带 /activate，2026-08-09 加的切 tab 取证）
  //   - visibilitychange 的 atlas 与 scroll 两条
  //   - 首屏 seed 那条 reseed（2026-08-18 补的，此前首屏路径**零埋点**，
  //     于是「重进应用全部空白」在日志里一个直接证据都没有）
  //
  // 按 kind 断言而不是数总数：硬编码总数会让**每新增一条探针**都在这里红一次，
  // 而那与本测试要守的性质无关。这里只列**同步发出**的那几条 —— 全链路采样
  // （write/render/screen）走 1.5s 延时，等真实时钟不属于这个测试的职责，
  // 它由 Terminal.sample.test.ts 用假时钟单独覆盖。
  const calls = diagCalls(rpc);
  const kinds = calls.map((c) => (c[1] as { kind?: string })?.kind);
  for (const k of ["atlas", "scroll", "reseed"]) {
    expect(kinds.filter((x) => x === k).length).toBeGreaterThanOrEqual(1);
  }
  const tags = calls.map((c) => (c[1] as { tag?: string })?.tag);
  expect(tags.filter((t) => t === "s-diag2/activate").length).toBe(1);
  expect(calls.filter((c) => (c[1] as { kind?: string })?.kind === "reseed").length).toBe(1);
  // 全部失败也不能有未捕获拒绝——这才是本测试真正要守的东西。
  expect(onRejection).not.toHaveBeenCalled();
});

test("stops reporting once the terminal is unmounted", async () => {
  const rpc = okRpc();
  const { unmount } = render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-diag3", active: true, streaming: true } });
  await new Promise((r) => setTimeout(r, 0));
  unmount();
  rpc.mockClear();

  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 0));

  expect(diagCalls(rpc).length).toBe(0);
});

// 需求 3（12 期）：回前台时除了图集快照，再发一条滚动状态快照。两条都在
// onVisible 里发，因为「回前台」正是这个 bug 唯一的发作时机。
test("reports a scroll snapshot when the page comes back to the foreground", async () => {
  const rpc = okRpc();
  render(Terminal, { props: { conn: stubConn(rpc), sessionId: "s-scroll", active: true, streaming: true } });
  await new Promise((r) => setTimeout(r, 0));
  rpc.mockClear();

  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 0));

  const scrollCalls = diagCalls(rpc).filter(
    (c: unknown[]) => (c[1] as { kind?: string })?.kind === "scroll",
  );
  expect(scrollCalls.length).toBe(1);
  expect(scrollCalls[0][1]).toMatchObject({ tag: "s-scroll", kind: "scroll" });
  // 快照字段必须真的带上——只发一个 kind 等于没埋点。
  expect(scrollCalls[0][1]).toHaveProperty("bufferLength");
  expect(scrollCalls[0][1]).toHaveProperty("cellHeight");
  expect(scrollCalls[0][1]).toHaveProperty("scrollHeight");
});

test("recovery diagnostics expose mode, queue state and byte counts without terminal content", async () => {
  let historyCall = 0;
  let resolveHistory!: (value: unknown) => void;
  const rpc = vi.fn().mockImplementation((method: string) => {
    if (method === "term.history") {
      historyCall++;
      if (historyCall === 1) {
        return Promise.resolve({ data: toB64(new TextEncoder().encode("initial\n")), seq: 6 });
      }
      if (historyCall === 2) return new Promise((resolve) => { resolveHistory = resolve; });
      return Promise.resolve({ data: toB64(new TextEncoder().encode("follow-up\n")), seq: 8 });
    }
    if (method === "term.paneInfo") {
      return Promise.resolve({ currentCommand: "zsh", alternateOn: false, isShell: true });
    }
    return Promise.resolve({});
  });
  const outputCallbacks: Array<(frame: { sessionId: string; seq: number; data: Uint8Array }) => void> = [];
  let requestReseed: ((trigger: any) => void) | undefined;
  const conn = {
    ...stubConn(rpc),
    onOutput: (cb: (frame: { sessionId: string; seq: number; data: Uint8Array }) => void) => {
      outputCallbacks.push(cb);
      return () => {};
    },
  } as any;
  render(Terminal, {
    props: {
      conn,
      sessionId: "s-recovery-diag",
      active: true,
      streaming: true,
      onReseedReady: (_id: string, fn: (trigger: any) => void) => { requestReseed = fn; },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  rpc.mockClear();

  requestReseed?.("resync");
  requestReseed?.("resync");
  const live = new TextEncoder().encode("SECRET-LIVE-COMMAND");
  for (const cb of outputCallbacks) cb({ sessionId: "s-recovery-diag", seq: 8, data: live });
  resolveHistory({
    data: toB64(new TextEncoder().encode("SECRET-SNAPSHOT-CONTENT\n")),
    seq: 7,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const reports = diagCalls(rpc)
    .map((call) => call[1] as Record<string, unknown>)
    .filter((payload) => payload.kind === "reseed" && payload.trigger === "resync");
  expect(reports.length).toBeGreaterThanOrEqual(1);
  expect(reports[0]).toMatchObject({ mode: "online", queued: true, liveBytes: live.byteLength });
  const encoded = JSON.stringify(reports[0]);
  expect(encoded).not.toContain("SECRET-LIVE-COMMAND");
  expect(encoded).not.toContain("SECRET-SNAPSHOT-CONTENT");
});

test.each([
  ["success", false],
  ["failure", true],
] as const)("offline recovery %s reports its real queued state and zero live bytes", async (_label, fail) => {
  let historyCall = 0;
  let settleOffline!: (value?: unknown) => void;
  const rpc = vi.fn().mockImplementation((method: string) => {
    if (method === "term.history") {
      historyCall++;
      if (historyCall === 1) {
        return Promise.resolve({ data: toB64(new TextEncoder().encode("initial\n")), seq: 4 });
      }
      return new Promise((resolve, reject) => {
        settleOffline = fail
          ? () => reject(new Error("disconnected"))
          : (value?: unknown) => resolve(value);
      });
    }
    if (method === "term.paneInfo") {
      return Promise.resolve({ currentCommand: "zsh", alternateOn: false, isShell: true });
    }
    return Promise.resolve({});
  });
  let requestReseed: ((trigger: any) => void) | undefined;
  const props = {
    conn: stubConn(rpc),
    sessionId: `s-offline-${_label}`,
    active: true,
    streaming: true,
    onReseedReady: (_id: string, fn: (trigger: any) => void) => { requestReseed = fn; },
  };
  const { rerender } = render(Terminal, { props });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await rerender({ ...props, streaming: false });
  rpc.mockClear();
  await rerender({ ...props, streaming: true });
  requestReseed?.("resync");
  requestReseed?.("resync");

  settleOffline(fail ? undefined : {
    data: toB64(new TextEncoder().encode("SECRET-OFFLINE-SNAPSHOT\n")),
    seq: 9,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const report = diagCalls(rpc)
    .map((call) => call[1] as Record<string, unknown>)
    .find((payload) => payload.kind === "reseed" && payload.trigger === "seed");
  expect(report).toMatchObject({ mode: "offline", queued: true, liveBytes: 0 });
  if (fail) {
    expect(report).toHaveProperty("error", "disconnected");
    // The queued resync must not bypass offline backoff and downgrade the
    // detached terminal to an online recovery before it can seed-attach.
    expect(historyCall).toBe(2);
  }
  expect(JSON.stringify(report)).not.toContain("SECRET-OFFLINE-SNAPSHOT");
});

test("recovery diagnostics make no RPC when the agent lacks the diag feature", async () => {
  const rpc = okRpc();
  const conn = stubConn(rpc);
  conn.hasFeature = () => false;
  render(Terminal, {
    props: { conn, sessionId: "s-no-recovery-diag", active: true, streaming: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(diagCalls(rpc)).toHaveLength(0);
});
