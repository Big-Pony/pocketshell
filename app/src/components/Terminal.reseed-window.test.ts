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
const hist = (text: string) => ({ data: toB64(new TextEncoder().encode(text)), seq: 7 });

type OutCb = (f: { sessionId: string; data: Uint8Array }) => void;

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
    } as any,
    emit: (sessionId: string, s: string) => {
      for (const cb of out) cb({ sessionId, data: new TextEncoder().encode(s) });
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
    render(Terminal, { props: { conn, sessionId: "s-eb", active: true, historyLines: 1000, onReseedReady: (_i: string, f: any) => { reseed = f; } } });
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
    render(Terminal, { props: { conn, sessionId: "s-len", active: true, onReseedReady: (_i: string, f: any) => { reseed = f; } } });
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
    render(Terminal, { props: { conn, sessionId: "s-fail", active: true, onReseedReady: (_i: string, f: any) => { reseed = f; } } });
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
    render(Terminal, { props: { conn, sessionId: "s-seedfail", active: true } });
    await tick(10);

    const reports = diagOf(rpc, "seed");
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0].error).toBe("rpc_timeout");
  });

  test("seedFromHistory 成功也上报 —— 没有成功基线就分不清「变好了」和「没人用」", async () => {
    const rpc = baseRpc(() => Promise.resolve(hist("ok\n")));
    const { conn } = stubConn(rpc);
    render(Terminal, { props: { conn, sessionId: "s-seedok", active: true } });
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
    render(Terminal, { props: { conn, sessionId: "s-retry", active: true, onReady: (_i: string, t: XTerm) => { xterm = t; } } });
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
    const { container } = render(Terminal, { props: { conn, sessionId: "s-clear", active: true } });
    await tick(1500);

    expect(container.querySelector(".term-seed")).toBeNull();
    expect(container.querySelector(".term-seed-retry")).toBeNull();
  });

  test("重试全部用尽后必须留下可见的重试入口（i18n，不得静默消失）", async () => {
    const rpc = baseRpc(() => Promise.reject(new Error("rpc_timeout")));
    const { conn } = stubConn(rpc);
    const { container } = render(Terminal, { props: { conn, sessionId: "s-give-up", active: true } });
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
    const { container } = render(Terminal, { props: { conn, sessionId: "s-manual", active: true } });
    await tick(5000);
    const before = calls;

    (container.querySelector(".term-seed-retry") as HTMLButtonElement).click();
    await tick(10);
    expect(calls).toBe(before + 1);
  }, 15_000);
});

// ── 4 ─────────────────────────────────────────────────────────────────
describe("4 · reloadHistory 的 t0..t1 窗口旁录", () => {
  test("★ await 期间到达的实时字节不再被 RIS 抹掉", async () => {
    let release: ((v: unknown) => void) | undefined;
    const rpc = baseRpc(() => new Promise((r) => { release = r; }));
    const { conn, emit } = stubConn(rpc);
    let xterm: XTerm | undefined;
    let reseed: ((t: any) => void) | undefined;
    render(Terminal, {
      props: {
        conn, sessionId: "s-win", active: true,
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
    release!(hist("SNAP-1\nSNAP-2\n"));    // t1：快照到达
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
        conn, sessionId: "s-stash", active: true,
        onReady: (_i: string, t: XTerm) => { xterm = t; },
        onReseedReady: (_i: string, f: any) => { reseed = f; },
      },
    });
    await tick();
    release!(hist(""));
    await tick(10);

    reseed?.("resync");                 // t0
    await tick();
    await rerender({ conn, sessionId: "s-stash", active: false } as any);
    emit("s-stash", "STASHED\r\n");    // 隐藏期到达 → pendingOut
    await tick();
    await rerender({ conn, sessionId: "s-stash", active: true } as any);
    await tick();                       // 激活 → flushPending 写进 xterm
    release!(hist("SNAP\n"));           // t1
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
        conn, sessionId: "s-mine", active: true,
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
    release!(hist("SNAP\n"));
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
        conn, sessionId: "s-stale", active: true,
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
    pending.shift()!(hist("STALE-SNAP\n")); // 第一代的快照，整份丢弃
    await tick(10);
    pending.shift()!(hist("FRESH-SNAP\n")); // 第二代的快照
    await tick(30);

    const rows = screen(xterm!);
    expect(rows).toContain("FRESH-SNAP");
    expect(rows).not.toContain("STALE-SNAP");
    // 过期那一代的窗口不得被回灌两次。
    expect(rows.filter((r) => r === "OLD-WINDOW").length).toBeLessThanOrEqual(1);
  });
});
