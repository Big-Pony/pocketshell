// 2026-08-18「多会话空白与输出丢失」的组件级契约（docs/需求/2026-08-18-多会话空白与输出丢失）。
//
// 这里钉的是 Terminal.svelte 的**接线**，纯逻辑在 lib/term/reseed.ts 的单测里。
// 四条独立契约：
//   1a term.history 必须带 expectBytes（否则 N 并发与 1 个拿同一个 10s 死线）
//   1b 首屏 seed 失败必须退避重试 + 留下可见可操作的入口（此前是永久吸收态）
//   1c 失败路径必须上报埋点；bufferLenAfter 必须在 write 回调里取（此前采样过早）
//   4  reloadHistory 的 t0..t1 窗口必须旁录并回灌（此前被 RIS 抹掉 →「中间几行消失」）
import { test, expect, vi, beforeAll, afterAll, describe } from "vitest";
import { render } from "@testing-library/svelte";
import Terminal from "./Terminal.svelte";
import type { Terminal as XTerm } from "@xterm/xterm";
import { toB64 } from "../lib/bytes";

let origMatchMedia: any;
beforeAll(() => {
  origMatchMedia = window.matchMedia;
  const mql = { matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} };
  window.matchMedia = vi.fn().mockReturnValue(mql);
});
afterAll(() => { window.matchMedia = origMatchMedia; });

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const hist = (text: string, seq = 7) => ({ data: toB64(new TextEncoder().encode(text)), seq });
const historyCalls = (rpc: ReturnType<typeof vi.fn>) =>
  rpc.mock.calls.filter((call) => call[0] === "term.history").length;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type OutCb = (f: { sessionId: string; data: Uint8Array; seq: number }) => void;

/** 可控的 conn 桩：暴露 onOutput 的回调，好在 await 窗口里注入实时帧。 */
function stubConn(rpc: ReturnType<typeof vi.fn>) {
  const out: OutCb[] = [];
  return {
    conn: {
      onOutput: (cb: OutCb) => { out.push(cb); return () => {}; },
      onInput: () => () => {},
      attach: vi.fn(),
      resize: () => {},
      rpc,
      hasFeature: (n: string) => n === "diag",
    } as any,
    // seq 缺省 0 = 「没有序号信息」，与 PendingBuffer.takeAfter 的语义一致：
    // 不关心快照分界线的用例照旧两参调用，行为不变。
    emit: (sessionId: string, s: string, seq = 0) => {
      for (const cb of out) cb({ sessionId, data: new TextEncoder().encode(s), seq });
    },
  };
}

/** 只回 paneInfo/redraw/diag 的默认桩，term.history 由各用例自己接管。 */
function baseRpc(onHistory: (n: number) => Promise<unknown>) {
  return vi.fn().mockImplementation((method: string, _p?: unknown, _o?: unknown) => {
    if (method === "term.history") return onHistory(0);
    if (method === "term.paneInfo") return Promise.resolve({ currentCommand: "zsh", alternateOn: false, isShell: true });
    return Promise.resolve({});
  });
}

const diagOf = (rpc: ReturnType<typeof vi.fn>, trigger?: string) =>
  rpc.mock.calls
    .filter((c) => c[0] === "diag.report")
    .map((c) => c[1] as Record<string, unknown>)
    .filter((p) => p.kind === "reseed" && (trigger === undefined || p.trigger === trigger));

const screen = (t: XTerm): string[] => {
  const out: string[] = [];
  for (let i = 0; i < t.buffer.active.length; i++) {
    out.push(t.buffer.active.getLine(i)?.translateToString(true) ?? "");
  }
  return out.filter((s) => s.trim().length > 0);
};

// ── 1a ────────────────────────────────────────────────────────────────
describe("1a · term.history 的死线记账", () => {
  test("两条路径都必须传 expectBytes —— 否则 8 并发与 1 个拿同一个 10s 死线", async () => {
    const rpc = baseRpc(() => Promise.resolve(hist("hello\n")));
    const { conn } = stubConn(rpc);
    let reseed: ((t: any) => void) | undefined;
    render(Terminal, { props: { conn, sessionId: "s-eb", active: true, streaming: true, historyLines: 1000, onReseedReady: (_i: string, f: any) => { reseed = f; } } });
    await tick();

    // 首屏 seed 这一次
    const seedCall = rpc.mock.calls.find((c) => c[0] === "term.history");
    expect(seedCall).toBeTruthy();
    expect((seedCall![2] as { expectBytes?: number })?.expectBytes).toBeGreaterThan(10_000);

    // 重灌那一次
    rpc.mockClear();
    reseed?.("resync");
    await tick();
    const reloadCall = rpc.mock.calls.find((c) => c[0] === "term.history");
    expect((reloadCall![2] as { expectBytes?: number })?.expectBytes).toBeGreaterThan(10_000);
  });
});

// ── 1c ────────────────────────────────────────────────────────────────
describe("1c · 埋点：失败要上报，bufferLenAfter 要在 write 回调里取", () => {
  test("bufferLenAfter 必须反映快照写入后的行数（此前在 write 同步下一行取，恒等于 before）", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `H${i}`).join("\n") + "\n";
    const rpc = baseRpc(() => Promise.resolve(hist(many)));
    const { conn } = stubConn(rpc);
    let reseed: ((t: any) => void) | undefined;
    render(Terminal, { props: { conn, sessionId: "s-len", active: true, streaming: true, onReseedReady: (_i: string, f: any) => { reseed = f; } } });
    await tick();
    rpc.mockClear();

    reseed?.("resync");
    await tick(30);

    const reports = diagOf(rpc, "resync");
    expect(reports.length).toBe(1);
    // 60 行历史灌进 24 行的终端 → buffer 必然长于 before。旧实现里 xterm 的
    // 写队列还没排空就读数，两者恒等 —— 真机日志 37/37 的 before 都等于 rows。
    expect(reports[0].bufferLenAfter).toBeGreaterThan(reports[0].bufferLenBefore as number);
  });

  test("reloadHistory 失败必须上报（此前埋点在 await 之后，超时就什么都没有）", async () => {
    const rpc = baseRpc(() => Promise.reject(Object.assign(new Error("rpc_timeout"), { code: "rpc_timeout" })));
    const { conn } = stubConn(rpc);
    let reseed: ((t: any) => void) | undefined;
    render(Terminal, { props: { conn, sessionId: "s-fail", active: true, streaming: true, onReseedReady: (_i: string, f: any) => { reseed = f; } } });
    await tick(10);
    rpc.mockClear();

    reseed?.("resync");
    await tick(10);

    const reports = diagOf(rpc, "resync");
    expect(reports.length).toBe(1);
    expect(reports[0].error).toBe("rpc_timeout");
    expect(reports[0].snapshotBytes).toBe(0);
  });

  test("seedFromHistory 失败必须上报 trigger:\"seed\" —— 首屏此前零埋点", async () => {
    const rpc = baseRpc(() => Promise.reject(new Error("rpc_timeout")));
    const { conn } = stubConn(rpc);
    render(Terminal, { props: { conn, sessionId: "s-seedfail", active: true, streaming: true } });
    await tick(10);

    const reports = diagOf(rpc, "seed");
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0].error).toBe("rpc_timeout");
  });

  test("seedFromHistory 成功也上报 —— 没有成功基线就分不清「变好了」和「没人用」", async () => {
    const rpc = baseRpc(() => Promise.resolve(hist("ok\n")));
    const { conn } = stubConn(rpc);
    render(Terminal, { props: { conn, sessionId: "s-seedok", active: true, streaming: true } });
    await tick(10);

    const reports = diagOf(rpc, "seed");
    expect(reports.length).toBe(1);
    expect("error" in reports[0]).toBe(false);
  });
});

// ── 1b ────────────────────────────────────────────────────────────────
describe("1b · 首屏失败不再是吸收态", () => {
  test("失败后自动退避重试 —— 一次抖动不该让 tab 永久空白", async () => {
    let calls = 0;
    const rpc = baseRpc(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("rpc_timeout")) : Promise.resolve(hist("RECOVERED\n"));
    });
    const { conn } = stubConn(rpc);
    let xterm: XTerm | undefined;
    render(Terminal, { props: { conn, sessionId: "s-retry", active: true, streaming: true, onReady: (_i: string, t: XTerm) => { xterm = t; } } });
    await tick(10);
    expect(calls).toBe(1); // 还没到重试点

    await tick(1200);      // 第一次退避 800ms
    expect(calls).toBe(2);
    await new Promise<void>((r) => xterm!.write("", () => r()));
    expect(screen(xterm!)).toContain("RECOVERED");
  });

  test("重试成功后进度提示必须消失 —— 否则内容出来了却一直盖着一层「正在重试」", async () => {
    let calls = 0;
    const rpc = baseRpc(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("rpc_timeout")) : Promise.resolve(hist("OK\n"));
    });
    const { conn } = stubConn(rpc);
    const { container } = render(Terminal, { props: { conn, sessionId: "s-clear", active: true, streaming: true } });
    await tick(1500);

    expect(container.querySelector(".term-seed")).toBeNull();
    expect(container.querySelector(".term-seed-retry")).toBeNull();
  });

  test("重试全部用尽后必须留下可见的重试入口（i18n，不得静默消失）", async () => {
    const rpc = baseRpc(() => Promise.reject(new Error("rpc_timeout")));
    const { conn } = stubConn(rpc);
    const { container } = render(Terminal, { props: { conn, sessionId: "s-give-up", active: true, streaming: true } });
    // 800 + 2400 = 3200ms 两次退避，留足余量。
    await tick(5000);

    const btn = container.querySelector(".term-seed-retry") as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    // vitest-setup 固定 zh：文案必须来自字典而不是硬编码字面量。
    expect(btn!.textContent?.trim()).toBe("重试");
    expect(container.textContent).toContain("读取会话历史失败");
  }, 15_000);

  test("点重试入口会真的再打一次 term.history", async () => {
    let calls = 0;
    const rpc = baseRpc(() => { calls++; return Promise.reject(new Error("rpc_timeout")); });
    const { conn } = stubConn(rpc);
    const { container } = render(Terminal, { props: { conn, sessionId: "s-manual", active: true, streaming: true } });
    await tick(5000);
    const before = calls;

    (container.querySelector(".term-seed-retry") as HTMLButtonElement).click();
    await tick(10);
    expect(calls).toBe(before + 1);
  }, 15_000);
});

describe("single-flight recovery requests", () => {
  test("hidden resync requests do no history work and coalesce on activation", async () => {
    const rpc = baseRpc(() => Promise.resolve(hist("seed\n")));
    const { conn } = stubConn(rpc);
    let requestReseed: ((trigger: any) => void) | undefined;
    const props = {
      conn,
      sessionId: "s-hidden-request",
      active: false,
      streaming: true,
      onReseedReady: (_id: string, fn: (trigger: any) => void) => { requestReseed = fn; },
    };
    const { rerender } = render(Terminal, { props });
    await tick(10);
    rpc.mockClear();

    requestReseed?.("resync");
    requestReseed?.("resync");
    requestReseed?.("resync");
    await tick();
    expect(historyCalls(rpc)).toBe(0);

    await rerender({ ...props, active: true });
    await tick(30);
    expect(historyCalls(rpc)).toBe(1);
  });

  test("repeated active requests produce at most one serial follow-up", async () => {
    const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
    let initial = true;
    const rpc = baseRpc(() => {
      if (initial) { initial = false; return Promise.resolve(hist("seed\n")); }
      const next = deferred<unknown>();
      pending.push(next);
      return next.promise;
    });
    const { conn } = stubConn(rpc);
    let requestReseed: ((trigger: any) => void) | undefined;
    render(Terminal, {
      props: {
        conn,
        sessionId: "s-single-flight",
        active: true,
        streaming: true,
        onReseedReady: (_id: string, fn: (trigger: any) => void) => { requestReseed = fn; },
      },
    });
    await tick(10);
    rpc.mockClear();

    requestReseed?.("resync");
    requestReseed?.("resync");
    requestReseed?.("resync");
    await tick();
    expect(historyCalls(rpc)).toBe(1);

    pending[0].resolve(hist("first\n", 20));
    await tick(30);
    expect(historyCalls(rpc)).toBe(2);

    pending[1].resolve(hist("second\n", 21));
    await tick(30);
    expect(historyCalls(rpc)).toBe(2);
  });

  test("a recovery hidden while pending waits for the next activation", async () => {
    const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
    let initial = true;
    const rpc = baseRpc(() => {
      if (initial) { initial = false; return Promise.resolve(hist("seed\n")); }
      const next = deferred<unknown>();
      pending.push(next);
      return next.promise;
    });
    const { conn } = stubConn(rpc);
    let xterm: XTerm | undefined;
    let requestReseed: ((trigger: any) => void) | undefined;
    const props = {
      conn,
      sessionId: "s-hide-pending",
      active: true,
      streaming: true,
      onReady: (_id: string, value: XTerm) => { xterm = value; },
      onReseedReady: (_id: string, fn: (trigger: any) => void) => { requestReseed = fn; },
    };
    const { rerender } = render(Terminal, { props });
    await tick(10);
    rpc.mockClear();

    requestReseed?.("resync");
    await tick();
    await rerender({ ...props, active: false });
    pending[0].resolve(hist("stale-hidden\n", 30));
    await tick(30);

    expect(historyCalls(rpc)).toBe(1);
    expect(screen(xterm!)).not.toContain("stale-hidden");

    await rerender({ ...props, active: true });
    await tick();
    expect(historyCalls(rpc)).toBe(2);
    pending[1].resolve(hist("fresh-visible\n", 31));
    await tick(30);
    expect(screen(xterm!)).toContain("fresh-visible");
  });

  test("snapshot boundary filtering keeps the online live window atomic", async () => {
    const pending = deferred<unknown>();
    let initial = true;
    const rpc = baseRpc(() => {
      if (initial) { initial = false; return Promise.resolve(hist("seed\n")); }
      return pending.promise;
    });
    const { conn, emit } = stubConn(rpc);
    let xterm: XTerm | undefined;
    let requestReseed: ((trigger: any) => void) | undefined;
    render(Terminal, {
      props: {
        conn,
        sessionId: "s-boundary",
        active: true,
        streaming: true,
        onReady: (_id: string, value: XTerm) => { xterm = value; },
        onReseedReady: (_id: string, fn: (trigger: any) => void) => { requestReseed = fn; },
      },
    });
    await tick(10);
    rpc.mockClear();

    const writes: Array<string | Uint8Array> = [];
    const callbacks: Array<() => void> = [];
    (xterm as any).write = (data: string | Uint8Array, callback?: () => void) => {
      writes.push(data);
      if (callback) callbacks.push(callback);
    };

    requestReseed?.("resync");
    emit("s-boundary", "AT-OR-BEFORE", 10);
    emit("s-boundary", "AFTER-CAPTURE", 11);
    pending.resolve(hist("SNAPSHOT\n", 10));
    await tick(30);
    emit("s-boundary", "AFTER-RESPONSE", 12);

    const writeText = writes.map((value) =>
      typeof value === "string" ? value : new TextDecoder().decode(value));
    const atomic = writeText.filter((value) => value.includes("\x1bc"));
    expect(atomic).toHaveLength(1);
    expect(atomic[0]).toContain("SNAPSHOT");
    expect(atomic[0]).toContain("AFTER-CAPTURE");
    expect(atomic[0]).not.toContain("AT-OR-BEFORE");
    expect(writeText.filter((value) => value === "AFTER-RESPONSE")).toHaveLength(1);

    callbacks[0]();
    await tick();
    expect(historyCalls(rpc)).toBe(1);
  });

  test("a dirty live window starts one follow-up only after snapshot commit", async () => {
    const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
    let initial = true;
    const rpc = baseRpc(() => {
      if (initial) { initial = false; return Promise.resolve(hist("seed\n")); }
      const next = deferred<unknown>();
      pending.push(next);
      return next.promise;
    });
    const { conn, emit } = stubConn(rpc);
    let xterm: XTerm | undefined;
    let requestReseed: ((trigger: any) => void) | undefined;
    render(Terminal, {
      props: {
        conn,
        sessionId: "s-dirty-window",
        active: true,
        streaming: true,
        onReady: (_id: string, value: XTerm) => { xterm = value; },
        onReseedReady: (_id: string, fn: (trigger: any) => void) => { requestReseed = fn; },
      },
    });
    await tick(10);
    rpc.mockClear();

    const commits: Array<() => void> = [];
    (xterm as any).write = (_data: string | Uint8Array, callback?: () => void) => {
      if (callback) commits.push(callback);
    };
    requestReseed?.("resync");
    emit("s-dirty-window", "X".repeat(2 * 1024 * 1024 + 1), 50);
    pending[0].resolve(hist("complete-first\n", 50));
    await tick();

    expect(historyCalls(rpc)).toBe(1);
    expect(commits).toHaveLength(1);
    commits[0]();
    await tick();
    expect(historyCalls(rpc)).toBe(2);

    pending[1].resolve(hist("complete-second\n", 51));
    await tick();
    expect(commits).toHaveLength(2);
    commits[1]();
    await tick();
    expect(historyCalls(rpc)).toBe(2);
  });
});

// ── 4 ─────────────────────────────────────────────────────────────────
// 【快照末尾为什么多一个空行】2026-08-25 起服务端的捕获终点钉在**光标那一行**
// （`capture-pane -E <cursor_y>`），客户端相应地去掉结尾那个换行 —— 于是「快照
// 最后一行」就是光标所在行。本节要验的是「窗口内的实时字节接在快照后面」，那批
// 字节在真机上是从新行开始的，对应的快照就得以一个**空的光标行**收尾。写成
// `"SNAP\n"` 会变成「光标停在 SNAP 行尾」，实时字节接上去是对的行为，但那验的
// 就不是本节要验的东西了。
describe("4 · reloadHistory 的 t0..t1 窗口旁录", () => {
  test("★ await 期间到达的实时字节不再被 RIS 抹掉", async () => {
    let release: ((v: unknown) => void) | undefined;
    const rpc = baseRpc(() => new Promise((r) => { release = r; }));
    const { conn, emit } = stubConn(rpc);
    let xterm: XTerm | undefined;
    let reseed: ((t: any) => void) | undefined;
    render(Terminal, {
      props: {
        conn, sessionId: "s-win", active: true, streaming: true,
        onReady: (_i: string, t: XTerm) => { xterm = t; },
        onReseedReady: (_i: string, f: any) => { reseed = f; },
      },
    });
    await tick();
    release!(hist("SEED\n"));      // 首屏 seed 先放行
    await tick(10);

    reseed?.("resync");            // t0：重灌开始，rpc 挂住
    await tick();
    emit("s-win", "LIVE-A\r\nLIVE-B\r\n"); // 窗口内的实时输出
    await tick();
    release!(hist("SNAP-1\nSNAP-2\n\n"));  // t1：快照到达（末尾空行 = 光标行）
    await tick(30);

    const rows = screen(xterm!);
    expect(rows).toEqual(["SNAP-1", "SNAP-2", "LIVE-A", "LIVE-B"]);
  });

  test("隐藏期积压、窗口内被 flush 的字节同样不能被 RIS 抹掉", async () => {
    // 重灌在路上时用户切走又切回：那批字节走的是 pendingOut → flushPending，
    // 不经过 onOutput 的 active 分支，于是不会自动进窗口。但它们同样是「写进
    // 了 xterm 却不在快照里」的字节，RIS 照样抹 —— 两条路径必须对称。
    let release: ((v: unknown) => void) | undefined;
    const rpc = baseRpc(() => new Promise((r) => { release = r; }));
    const { conn, emit } = stubConn(rpc);
    let xterm: XTerm | undefined;
    let reseed: ((t: any) => void) | undefined;
    const { rerender } = render(Terminal, {
      props: {
        conn, sessionId: "s-stash", active: true, streaming: true,
        onReady: (_i: string, t: XTerm) => { xterm = t; },
        onReseedReady: (_i: string, f: any) => { reseed = f; },
      },
    });
    await tick();
    release!(hist(""));
    await tick(10);

    reseed?.("resync");                 // t0
    await tick();
    await rerender({ conn, sessionId: "s-stash", active: false, streaming: true } as any);
    emit("s-stash", "STASHED\r\n");    // 隐藏期到达 → pendingOut
    await tick();
    await rerender({ conn, sessionId: "s-stash", active: true, streaming: true } as any);
    await tick();                       // 激活 → flushPending 写进 xterm
    release!(hist("SNAP\n\n"));         // t1（末尾空行 = 光标行）
    await tick(30);

    expect(screen(xterm!)).toContain("STASHED");
  });

  test("别的会话的输出不能混进本会话的窗口", async () => {
    let release: ((v: unknown) => void) | undefined;
    const rpc = baseRpc(() => new Promise((r) => { release = r; }));
    const { conn, emit } = stubConn(rpc);
    let xterm: XTerm | undefined;
    let reseed: ((t: any) => void) | undefined;
    render(Terminal, {
      props: {
        conn, sessionId: "s-mine", active: true, streaming: true,
        onReady: (_i: string, t: XTerm) => { xterm = t; },
        onReseedReady: (_i: string, f: any) => { reseed = f; },
      },
    });
    await tick();
    release!(hist(""));
    await tick(10);

    reseed?.("resync");
    await tick();
    emit("s-other", "FOREIGN\r\n");
    await tick();
    release!(hist("SNAP\n\n"));
    await tick(30);

    expect(screen(xterm!)).toEqual(["SNAP"]);
  });

  test("快照被代际闸门判为过期时，它的窗口字节一起丢弃 —— 否则旧窗口污染新一代", async () => {
    const pending: ((v: unknown) => void)[] = [];
    const rpc = baseRpc(() => new Promise((r) => { pending.push(r); }));
    const { conn, emit } = stubConn(rpc);
    let xterm: XTerm | undefined;
    let reseed: ((t: any) => void) | undefined;
    render(Terminal, {
      props: {
        conn, sessionId: "s-stale", active: true, streaming: true,
        onReady: (_i: string, t: XTerm) => { xterm = t; },
        onReseedReady: (_i: string, f: any) => { reseed = f; },
      },
    });
    await tick();
    pending.shift()!(hist(""));    // 首屏
    await tick(10);

    reseed?.("resync");            // 第一代
    await tick();
    emit("s-stale", "OLD-WINDOW\r\n");
    reseed?.("resync");            // 第二代（第一代就此过期）
    await tick();
    emit("s-stale", "NEW-WINDOW\r\n");
    pending.shift()!(hist("STALE-SNAP\n\n")); // 第一代的快照，整份丢弃
    await tick(10);
    pending.shift()!(hist("FRESH-SNAP\n\n")); // 第二代的快照
    await tick(30);

    const rows = screen(xterm!);
    expect(rows).toContain("FRESH-SNAP");
    expect(rows).not.toContain("STALE-SNAP");
    // 过期那一代的窗口不得被回灌两次。
    expect(rows.filter((r) => r === "OLD-WINDOW").length).toBeLessThanOrEqual(1);
  });
});

// ── 5 ────────────────────────────────────────────────────────────────
// 重灌拉的行数不能少于 buffer 里已有的。RIS 清的是**整个** buffer（含
// scrollback），只回写 historyLines 行的话，差额就是被抹掉的历史。
//
// 真机 aippt（agent.out.log 2026-08-22/23）三次 resync：
//   bufferLenBefore=1219 → After=634、882 → 506、859 → 507
// 即单次净损失 585/376/352 行 —— 用户报告的「文本内容不连贯」。
//
// 纯逻辑在 reseed.ts 的 reseedLines 单测里；这里钉的是**接线**：调用点
// 真的把 buffer 长度喂进去了，而不是继续传 historyLines。少了这条，把
// `reseedLines(historyLines, lenBefore)` 改回 `historyLines` 依然全绿。
describe("5 · 重灌行数不得少于 buffer 现有行数", () => {
  test("buffer 比 historyLines 长时，term.history 要按 buffer 行数拉", async () => {
    // 先用一份长历史把 buffer 撑到 1000 行以上
    const long = Array.from({ length: 1200 }, (_, i) => `L${i}`).join("\n") + "\n";
    const rpc = baseRpc(() => Promise.resolve(hist(long)));
    const { conn } = stubConn(rpc);
    let reseed: ((t: any) => void) | undefined;
    render(Terminal, {
      props: {
        conn, sessionId: "s-lines", active: true, streaming: true, historyLines: 1000,
        onReseedReady: (_i: string, f: any) => { reseed = f; },
      },
    });
    await tick(50);

    rpc.mockClear();
    reseed?.("resync");
    await tick(50);

    const call = rpc.mock.calls.find((c) => c[0] === "term.history");
    expect(call).toBeTruthy();
    const asked = (call![1] as { lines?: number }).lines ?? 0;
    // buffer 此刻远超 1000 行，要的行数必须跟着涨（上限 2000）
    expect(asked).toBeGreaterThan(1000);
    expect(asked).toBeLessThanOrEqual(2000);
    // expectBytes 要跟着同一个数走，否则死线按 1000 行算，拉 1200 行必假超时
    const eb = (call![2] as { expectBytes?: number })?.expectBytes ?? 0;
    expect(eb).toBe(asked * 30);
  });

  test("buffer 短时仍按 historyLines 拉 —— 不因为一次重灌就多要几百行", async () => {
    const rpc = baseRpc(() => Promise.resolve(hist("short\n")));
    const { conn } = stubConn(rpc);
    let reseed: ((t: any) => void) | undefined;
    render(Terminal, {
      props: {
        conn, sessionId: "s-lines2", active: true, streaming: true, historyLines: 1000,
        onReseedReady: (_i: string, f: any) => { reseed = f; },
      },
    });
    await tick(50);

    rpc.mockClear();
    reseed?.("resync");
    await tick(50);

    const call = rpc.mock.calls.find((c) => c[0] === "term.history");
    expect((call![1] as { lines?: number }).lines).toBe(1000);
  });
});

// ── 5 ─────────────────────────────────────────────────────────────────
// 【2026-08-27 teachppt「AI 最后一次的输出不见了」】
//
// 隐藏的 tab 把实时字节攒在 pendingOut 里（R1），而 resync 触发的重灌**不看
// 可见性**：它照样把 RIS + 整份 tmux 快照写进 xterm。快照拍的是 tmux 此刻的
// 画面，攒着的那些字节早就体现在里面了。等用户切回来，flushPending 又把这批
// **已经过时**的字节整份重放到一份正确的 buffer 上 —— 它们是 Claude Code 的
// 增量重绘流（\r、光标上移、擦行），落在已是终态的屏幕上就是一边重复一边覆盖。
//
// 真机取证（agent.out.log，teachppt）：tab 隐藏 26.5 分钟期间发生两次
// `reseed trigger:"resync"`，激活那一刻 `write phase:"activate"
// wroteFrames:645 wroteBytes:104599 bufDelta:111` —— 104KB 陈旧字节压在快照上，
// 随后的 scrollback 对拍 `missingLines:87 extraLines:59`。
//
// 分界线是现成的：term.history 是**先取号后快照**，返回的 seq 就是「这个号
// 以前的字节都已经在快照里了」。
describe("5 · 隐藏期的积压不得压在重灌之后（teachppt 丢内容）", () => {
  test("★ 快照已经覆盖的那批积压字节，激活时不得再重放一遍", async () => {
    const rpc = baseRpc(() => Promise.resolve(hist("")));
    const { conn, emit } = stubConn(rpc);
    let xterm: XTerm | undefined;
    let reseed: ((t: any) => void) | undefined;
    const props = {
      conn, sessionId: "s-hidden", streaming: true, historyLines: 1000,
      onReady: (_i: string, t: XTerm) => { xterm = t; },
      onReseedReady: (_i: string, f: any) => { reseed = f; },
    };
    const { rerender } = render(Terminal, { props: { ...props, active: false } as any });
    await tick(10);

    // 隐藏期：AI 的输出到达（seq 1..2），进 pendingOut。
    emit("s-hidden", "AI-REPLY\r\n", 1);
    emit("s-hidden", "AI-TAIL\r\n", 2);
    await tick();

    // 掉线重连 → 服务端说 resync。快照 seq=2 ⇒ 上面两帧都已在快照里。
    rpc.mockImplementation((m: string) =>
      m === "term.history" ? Promise.resolve(hist("AI-REPLY\nAI-TAIL\n\n", 2))
      : m === "term.paneInfo" ? Promise.resolve({ currentCommand: "zsh", alternateOn: false, isShell: true })
      : Promise.resolve({}));
    reseed?.("resync");
    await tick(30);

    // 快照之后才产生的字节（seq 3）必须留着 —— 它不在快照里。
    emit("s-hidden", "AFTER-SNAP\r\n", 3);
    await tick();

    await rerender({ ...props, active: true } as any);
    await tick(30);
    await new Promise<void>((r) => xterm!.write("", () => r()));

    const rows = screen(xterm!);
    expect(rows.filter((r) => r === "AI-REPLY").length).toBe(1);
    expect(rows.filter((r) => r === "AI-TAIL").length).toBe(1);
    expect(rows).toContain("AFTER-SNAP");
  });

  test("没发生过重灌时，隐藏期积压照旧全量重放（R1 的原有语义不能被改坏）", async () => {
    const rpc = baseRpc(() => Promise.resolve(hist("SEED\n\n")));
    const { conn, emit } = stubConn(rpc);
    let xterm: XTerm | undefined;
    const props = {
      conn, sessionId: "s-plain", streaming: true,
      onReady: (_i: string, t: XTerm) => { xterm = t; },
    };
    const { rerender } = render(Terminal, { props: { ...props, active: false } as any });
    await tick(10);

    emit("s-plain", "ONLY-IN-STASH\r\n", 11);
    await tick();
    await rerender({ ...props, active: true } as any);
    await tick(30);
    await new Promise<void>((r) => xterm!.write("", () => r()));

    expect(screen(xterm!)).toContain("ONLY-IN-STASH");
  });
});
