import { test, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import { Terminal } from "@xterm/xterm";
import TerminalView, { PendingBuffer } from "../src/components/Terminal.svelte";
import { FitAddon } from "@xterm/addon-fit";
import { toB64 } from "../src/lib/bytes";
import type { Connection } from "../src/lib/connection";

// xterm can't run under jsdom (no layout/canvas), and we want to spy on the
// writes, so the Terminal class is mocked. The mock records every written
// chunk and lets a test flip the buffer type through onBufferChange.
interface MockTerm {
  cols: number;
  rows: number;
  written: unknown[];
  clearCount: number;
  setBuffer(type: string): void;
}
const termInstances = (): MockTerm[] => (Terminal as unknown as { instances: MockTerm[] }).instances;

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    static instances: MockTerminal[] = [];
    cols = 80;
    rows = 24;
    written: unknown[] = [];
    clearCount = 0;
    options: Record<string, unknown>;
    buffer: { active: { type: string }; onBufferChange: (cb: (buf: { type: string }) => void) => void };
    private bufCbs: ((buf: { type: string }) => void)[] = [];
    constructor(opts: Record<string, unknown>) {
      this.options = opts;
      this.buffer = { active: { type: "normal" }, onBufferChange: (cb) => { this.bufCbs.push(cb); } };
      MockTerminal.instances.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    write(data: unknown, cb?: () => void): void { this.written.push(data); cb?.(); }
    resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; }
    clear(): void { this.clearCount++; }
    dispose(): void {}
    setBuffer(type: string): void {
      this.buffer.active = { type };
      for (const cb of this.bufCbs) cb({ type });
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    // Mutable so a test can simulate the viewport changing size.
    static dims = { cols: 80, rows: 24 };
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } { return FitAddon.dims; }
  },
}));

type OutputFrame = { sessionId: string; seq: number; data: Uint8Array };

// Minimal Connection stand-in: records attach/rpc calls and lets a test push
// output frames into the subscribed callbacks.
function stubConn() {
  const outputCbs: ((f: OutputFrame) => void)[] = [];
  const inputCbs: ((sid: string) => void)[] = [];
  const conn = {
    attach: vi.fn(),
    detach: vi.fn(),
    resize: vi.fn(),
    rpc: vi.fn(async (method: string) => {
      if (method === "term.paneInfo") return { currentCommand: "zsh", alternateOn: false, isShell: true };
      if (method === "term.history") return { data: toB64(new TextEncoder().encode("HISTORY\n")) };
      return {};
    }),
    onOutput: (cb: (f: OutputFrame) => void) => { outputCbs.push(cb); return () => {}; },
    onInput: (cb: (sid: string) => void) => { inputCbs.push(cb); return () => {}; },
    emit(sessionId: string, data: Uint8Array, seq = 1): void {
      for (const cb of outputCbs) cb({ sessionId, seq, data });
    },
    emitInput(sessionId: string): void {
      for (const cb of inputCbs) cb(sessionId);
    },
  };
  return conn;
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: unknown) => new TextDecoder().decode(b as Uint8Array);

function propsFor(conn: ReturnType<typeof stubConn>, active: boolean, closed = false) {
  return { conn: conn as unknown as Connection, sessionId: "s1", active, closed, fontSize: 14 };
}

// Wait until onMount finished: attach sent + first paneInfo edge reseeded history.
async function settleMount(conn: ReturnType<typeof stubConn>) {
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("s1"));
  await waitFor(() => expect(conn.rpc).toHaveBeenCalledWith("term.history", { session: "s1" }));
}

// ──────────────────────────────────────────────────────────────
// PendingBuffer (R1): pure buffering semantics
// ──────────────────────────────────────────────────────────────
test("PendingBuffer concatenates chunks in order and resets on take", () => {
  const b = new PendingBuffer(1024);
  expect(b.take()).toBeNull();
  b.push(enc("AB"));
  b.push(enc("CD"));
  expect(dec(b.take())).toBe("ABCD");
  expect(b.take()).toBeNull(); // drained
});

test("PendingBuffer over the limit drops everything and goes dirty", () => {
  const b = new PendingBuffer(4);
  b.push(enc("AB"));
  b.push(enc("CD"));
  expect(b.dirty).toBe(false);
  b.push(enc("E")); // 5 > 4 -> overflow
  expect(b.dirty).toBe(true);
  expect(b.take()).toBeNull(); // nothing left to flush
  b.push(enc("FG")); // ignored while dirty
  expect(b.take()).toBeNull();
  b.clearDirty();
  b.push(enc("HI"));
  expect(dec(b.take())).toBe("HI"); // usable again after reseed
});

// ──────────────────────────────────────────────────────────────
// R1: hidden terminal does not write to xterm; activation flushes one write
// ──────────────────────────────────────────────────────────────
test("hidden terminal stashes output and flushes it as one write on activation", async () => {
  const conn = stubConn();
  const { rerender } = render(TerminalView, { props: propsFor(conn, true) });
  await settleMount(conn);
  const term = termInstances().at(-1)!;

  await rerender(propsFor(conn, false));
  const beforeHidden = term.written.length;
  conn.emit("s1", enc("AB"), 1);
  conn.emit("s1", enc("CD"), 2);
  conn.emit("other", enc("ZZ"), 3); // different session — never ours
  await new Promise((r) => setTimeout(r, 20));
  expect(term.written.length).toBe(beforeHidden); // nothing written while hidden

  await rerender(propsFor(conn, true));
  await waitFor(() => expect(term.written.length).toBe(beforeHidden + 1));
  expect(dec(term.written.at(-1))).toBe("ABCD"); // single concatenated flush
});

// ──────────────────────────────────────────────────────────────
// R1: frames for a tombstoned session are dropped, not stashed
// ──────────────────────────────────────────────────────────────
test("closed terminal ignores frames while hidden", async () => {
  const conn = stubConn();
  const { rerender } = render(TerminalView, { props: propsFor(conn, true) });
  await settleMount(conn);
  const term = termInstances().at(-1)!;

  await rerender(propsFor(conn, false, true));
  const before = term.written.length;
  conn.emit("s1", enc("AB"), 1);
  await rerender(propsFor(conn, true, true));
  await new Promise((r) => setTimeout(r, 20));
  expect(term.written.length).toBe(before); // no stash, no flush
});

// ──────────────────────────────────────────────────────────────
// R1: stash overflow (>2MB) discards the stream; activation reseeds from tmux
// ──────────────────────────────────────────────────────────────
test("overflow while hidden reseeds via term.history instead of flushing", async () => {
  const conn = stubConn();
  const { rerender } = render(TerminalView, { props: propsFor(conn, true) });
  await settleMount(conn);
  const term = termInstances().at(-1)!;
  const historyCalls = () => conn.rpc.mock.calls.filter((c) => c[0] === "term.history").length;
  const h0 = historyCalls();

  await rerender(propsFor(conn, false));
  conn.emit("s1", new Uint8Array(2 * 1024 * 1024 + 1), 1); // over the 2MB cap

  await rerender(propsFor(conn, true));
  await waitFor(() => expect(historyCalls()).toBe(h0 + 1)); // full reseed happened
  // The truncated stash was never written: no chunk anywhere near 2MB.
  expect(term.written.some((c) => c instanceof Uint8Array && c.byteLength > 2 * 1024 * 1024)).toBe(false);
  expect(term.written.at(-1)).toBe("HISTORY\r\n"); // reseed content is the last write
});

// ──────────────────────────────────────────────────────────────
// R1: overflow in the alternate buffer asks the pane app to repaint
// (capture-pane is useless there)
// ──────────────────────────────────────────────────────────────
test("overflow while hidden in the alt buffer triggers term.redraw on activation", async () => {
  const conn = stubConn();
  const { rerender } = render(TerminalView, { props: propsFor(conn, true) });
  await settleMount(conn);
  const term = termInstances().at(-1)!;
  const historyCalls = () => conn.rpc.mock.calls.filter((c) => c[0] === "term.history").length;
  const h0 = historyCalls();

  term.setBuffer("alternate"); // pane flipped to alt screen while visible
  await rerender(propsFor(conn, false));
  conn.emit("s1", new Uint8Array(2 * 1024 * 1024 + 1), 1);

  await rerender(propsFor(conn, true));
  await waitFor(() => expect(conn.rpc).toHaveBeenCalledWith("term.redraw", { session: "s1" }));
  expect(historyCalls()).toBe(h0); // no capture-pane reseed in the alt buffer
});

// Drain the microtask queue: Svelte flushes $effects + the activation
// microtask (refit + startPoll) there, and the stub RPCs resolve there too.
const flushMicro = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const paneInfoCalls = (conn: ReturnType<typeof stubConn>) =>
  conn.rpc.mock.calls.filter((c) => c[0] === "term.paneInfo").length;

// ──────────────────────────────────────────────────────────────
// A4: the classifyPane poll runs only while the terminal is active — hiding
// pauses it, re-activation classifies once right away and resumes the cadence
// ──────────────────────────────────────────────────────────────
test("A4: classifyPane polls only while active; hide pauses, reactivate re-classifies + resumes", async () => {
  vi.useFakeTimers();
  try {
    const conn = stubConn();
    const { rerender } = render(TerminalView, { props: propsFor(conn, true) });
    await flushMicro();
    expect(paneInfoCalls(conn)).toBe(1); // activation edge: one immediate classify

    await vi.advanceTimersByTimeAsync(2000);
    expect(paneInfoCalls(conn)).toBe(2); // 2s cadence running

    await rerender(propsFor(conn, false));
    await flushMicro();
    await vi.advanceTimersByTimeAsync(5000);
    expect(paneInfoCalls(conn)).toBe(2); // paused while hidden

    await rerender(propsFor(conn, true));
    await flushMicro();
    expect(paneInfoCalls(conn)).toBe(3); // reactivation classifies right away…
    await vi.advanceTimersByTimeAsync(2000);
    expect(paneInfoCalls(conn)).toBe(4); // …then the cadence resumes
  } finally {
    vi.useRealTimers();
  }
});

// ──────────────────────────────────────────────────────────────
// A4: a tombstoned (closed/done) session stops the poll for good, and the
// input-debounced re-classify is gated off too
// ──────────────────────────────────────────────────────────────
test("A4: tombstoning stops the poll and the input-debounced re-classify", async () => {
  vi.useFakeTimers();
  try {
    const conn = stubConn();
    const { rerender } = render(TerminalView, { props: propsFor(conn, true) });
    await flushMicro();
    expect(paneInfoCalls(conn)).toBe(1);

    // live + active: outbound input re-classifies after the 200ms debounce
    conn.emitInput("s1");
    await vi.advanceTimersByTimeAsync(199);
    expect(paneInfoCalls(conn)).toBe(1); // debounce still pending
    await vi.advanceTimersByTimeAsync(1);
    expect(paneInfoCalls(conn)).toBe(2);

    // tombstone: the 2s poll stops and input no longer schedules a classify
    await rerender(propsFor(conn, true, true));
    await flushMicro();
    conn.emitInput("s1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(paneInfoCalls(conn)).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

// ──────────────────────────────────────────────────────────────
// A4: a terminal that mounts tombstoned (restored dead tab) never classifies
// ──────────────────────────────────────────────────────────────
test("A4: a terminal mounted closed never polls at all", async () => {
  vi.useFakeTimers();
  try {
    const conn = stubConn();
    render(TerminalView, { props: propsFor(conn, false, true) });
    await flushMicro();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(paneInfoCalls(conn)).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

// ──────────────────────────────────────────────────────────────
// R3: window resize collapses into one trailing refit (~150ms debounce), and
// conn.resize goes out only when cols/rows actually changed
// ──────────────────────────────────────────────────────────────
test("R3: window resize debounces to one refit; resize frames only on real change", async () => {
  vi.useFakeTimers();
  const fitMock = FitAddon as unknown as { dims: { cols: number; rows: number } };
  try {
    const conn = stubConn();
    render(TerminalView, { props: propsFor(conn, true) });
    await flushMicro();
    // The mount refit pushes the initial size once; the activation microtask's
    // activateRefit (需求2) bypasses the suppression guard on purpose so it
    // resends even though dims are unchanged — a second, same-size frame.
    expect(conn.resize).toHaveBeenCalledTimes(2);
    expect(conn.resize).toHaveBeenLastCalledWith("s1", 80, 24);

    // A drag burst collapses into a single trailing refit.
    fitMock.dims = { cols: 100, rows: 30 };
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(149);
    expect(conn.resize).toHaveBeenCalledTimes(2); // debounce still pending
    await vi.advanceTimersByTimeAsync(1);
    await flushMicro();
    expect(conn.resize).toHaveBeenCalledTimes(3);
    expect(conn.resize).toHaveBeenLastCalledWith("s1", 100, 30);

    // Another burst with no dimension change sends nothing at all.
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(500);
    await flushMicro();
    expect(conn.resize).toHaveBeenCalledTimes(3);
  } finally {
    fitMock.dims = { cols: 80, rows: 24 };
    vi.useRealTimers();
  }
});
