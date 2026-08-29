import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import type { Terminal as XTerm } from "@xterm/xterm";
import Terminal from "./Terminal.svelte";
import { toB64 } from "../lib/bytes";

const gunzipControl = vi.hoisted(() => ({
  decode: (bytes: Uint8Array) => Promise.resolve(bytes),
}));
vi.mock("../lib/gunzip", () => ({
  gunzip: (bytes: Uint8Array) => gunzipControl.decode(bytes),
}));

type OutputFrame = { sessionId: string; seq: number; data: Uint8Array };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const historyCalls = (conn: ReturnType<typeof stubConn>) =>
  conn.rpc.mock.calls.filter((call) => call[0] === "term.history").length;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function stubConn(history = () => Promise.resolve({
  data: toB64(new TextEncoder().encode("snapshot\n")),
  seq: 7,
})) {
  const outputCallbacks: Array<(frame: OutputFrame) => void> = [];
  const conn = {
    attach: vi.fn(),
    detach: vi.fn(),
    resize: vi.fn(),
    rpc: vi.fn((method: string) => {
      if (method === "term.history") {
        return history();
      }
      if (method === "term.paneInfo") {
        return Promise.resolve({ currentCommand: "zsh", alternateOn: false, isShell: true });
      }
      return Promise.resolve({});
    }),
    onOutput: (cb: (frame: OutputFrame) => void) => {
      outputCallbacks.push(cb);
      return () => {};
    },
    onInput: () => () => {},
    emit(sessionId: string, text: string, seq = 8) {
      const data = new TextEncoder().encode(text);
      for (const cb of outputCallbacks) cb({ sessionId, seq, data });
    },
  };
  return conn;
}

function screenText(term: XTerm): string {
  const lines: string[] = [];
  for (let i = 0; i < term.buffer.active.length; i++) {
    lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

let originalMatchMedia: typeof window.matchMedia;
beforeAll(() => {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
});
afterAll(() => {
  window.matchMedia = originalMatchMedia;
});
afterEach(() => {
  gunzipControl.decode = (bytes: Uint8Array) => Promise.resolve(bytes);
});

test("a hidden non-streaming mount does no history work and starts once streaming", async () => {
  const conn = stubConn();
  const { rerender } = render(Terminal, {
    props: { conn: conn as any, sessionId: "A", active: false, streaming: false },
  });
  await tick();

  expect(historyCalls(conn)).toBe(0);
  expect(conn.attach).not.toHaveBeenCalled();

  await rerender({ conn: conn as any, sessionId: "A", active: false, streaming: true });
  await tick();

  expect(historyCalls(conn)).toBe(1);
  expect(conn.attach).toHaveBeenCalledWith("A", 7, { seed: true });

  await rerender({ conn: conn as any, sessionId: "A", active: false, streaming: true });
  expect(conn.detach).not.toHaveBeenCalled();
});

test("hiding during the grace window keeps the existing stream without reseeding", async () => {
  const conn = stubConn();
  const { rerender } = render(Terminal, {
    props: { conn: conn as any, sessionId: "A", active: true, streaming: true },
  });
  await tick();
  expect(historyCalls(conn)).toBe(1);

  await rerender({ conn: conn as any, sessionId: "A", active: false, streaming: true });
  await tick();
  await rerender({ conn: conn as any, sessionId: "A", active: true, streaming: true });
  await tick();

  expect(historyCalls(conn)).toBe(1);
  expect(conn.detach).not.toHaveBeenCalled();
});

test("stopping a stream detaches once and drops later output without changing xterm", async () => {
  const conn = stubConn();
  let term: XTerm | undefined;
  const { rerender } = render(Terminal, {
    props: {
      conn: conn as any,
      sessionId: "A",
      active: true,
      streaming: true,
      onReady: (_id: string, value: XTerm) => { term = value; },
    },
  });
  await waitFor(() => expect(term && screenText(term)).toContain("snapshot"));

  await rerender({
    conn: conn as any,
    sessionId: "A",
    active: false,
    streaming: true,
    onReady: (_id: string, value: XTerm) => { term = value; },
  });
  conn.emit("A", "BUFFERED", 8);
  await rerender({
    conn: conn as any,
    sessionId: "A",
    active: false,
    streaming: false,
    onReady: (_id: string, value: XTerm) => { term = value; },
  });
  const before = screenText(term!);
  conn.emit("A", "AFTER-STOP", 9);
  await tick();

  expect(conn.detach).toHaveBeenCalledTimes(1);
  expect(conn.detach).toHaveBeenCalledWith("A");
  expect(screenText(term!)).toBe(before);
  expect(screenText(term!)).not.toContain("BUFFERED");
  expect(screenText(term!)).not.toContain("AFTER-STOP");

  await rerender({
    conn: conn as any,
    sessionId: "A",
    active: false,
    streaming: false,
    onReady: (_id: string, value: XTerm) => { term = value; },
  });
  expect(conn.detach).toHaveBeenCalledTimes(1);
});

test("stopping a stream cancels a scheduled initial seed retry", async () => {
  vi.useFakeTimers();
  try {
    const conn = stubConn(() => Promise.reject(new Error("offline")));
    const { rerender } = render(Terminal, {
      props: { conn: conn as any, sessionId: "A", active: true, streaming: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(historyCalls(conn)).toBe(1);

    await rerender({ conn: conn as any, sessionId: "A", active: true, streaming: false });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(historyCalls(conn)).toBe(1);
    expect(conn.detach).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("offline resume attaches only after the snapshot write commits", async () => {
  const resumeHistory = deferred<{ data: string; seq: number }>();
  let calls = 0;
  const conn = stubConn(() => {
    calls++;
    if (calls === 1) {
      return Promise.resolve({ data: toB64(new TextEncoder().encode("old-screen\n")), seq: 3 });
    }
    return resumeHistory.promise;
  });
  let term: XTerm | undefined;
  const props = {
    conn: conn as any,
    sessionId: "A",
    active: true,
    streaming: true,
    onReady: (_id: string, value: XTerm) => { term = value; },
  };
  const { rerender } = render(Terminal, { props });
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 3, { seed: true }));

  await rerender({ ...props, streaming: false });
  conn.attach.mockClear();
  let commit: (() => void) | undefined;
  const write = vi.fn((_data: string | Uint8Array, callback?: () => void) => { commit = callback; });
  (term as any).write = write;

  await rerender({ ...props, streaming: true });
  expect(historyCalls(conn)).toBe(2);
  expect(conn.attach).not.toHaveBeenCalled();

  resumeHistory.resolve({ data: toB64(new TextEncoder().encode("fresh-screen\n")), seq: 11 });
  await tick();
  expect(write).toHaveBeenCalledTimes(1);
  expect(String(write.mock.calls[0][0])).toContain("fresh-screen");
  expect(String(write.mock.calls[0][0])).toContain("\x1bc");
  expect(conn.attach).not.toHaveBeenCalled();

  commit?.();
  expect(conn.attach).toHaveBeenCalledWith("A", 11, { seed: true });
});

test("a stopped generation cannot write or attach when its history arrives", async () => {
  const history = deferred<{ data: string; seq: number }>();
  const conn = stubConn(() => history.promise);
  let term: XTerm | undefined;
  const props = {
    conn: conn as any,
    sessionId: "A",
    active: true,
    streaming: false,
    onReady: (_id: string, value: XTerm) => { term = value; },
  };
  const { rerender } = render(Terminal, { props });
  await tick();
  const write = vi.fn();
  (term as any).write = write;

  await rerender({ ...props, streaming: true });
  expect(historyCalls(conn)).toBe(1);
  await rerender({ ...props, streaming: false });
  history.resolve({ data: toB64(new TextEncoder().encode("stale-content\n")), seq: 13 });
  await tick();

  expect(write).not.toHaveBeenCalled();
  expect(conn.attach).not.toHaveBeenCalled();
});

test("a hidden stale offline response retries offline on activation and reattaches", async () => {
  const stale = deferred<{ data: string; seq: number }>();
  const fresh = deferred<{ data: string; seq: number }>();
  let call = 0;
  const conn = stubConn(() => {
    call++;
    if (call === 1) return Promise.resolve({
      data: toB64(new TextEncoder().encode("initial\n")), seq: 3,
    });
    if (call === 2) return stale.promise;
    return fresh.promise;
  });
  const props = { conn: conn as any, sessionId: "A", active: true, streaming: true };
  const { rerender } = render(Terminal, { props });
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 3, { seed: true }));

  await rerender({ ...props, streaming: false });
  conn.attach.mockClear();
  await rerender({ ...props, streaming: true });
  expect(historyCalls(conn)).toBe(2);

  await rerender({ ...props, active: false });
  stale.resolve({ data: toB64(new TextEncoder().encode("stale-hidden\n")), seq: 10 });
  await tick();
  expect(historyCalls(conn)).toBe(2);
  expect(conn.attach).not.toHaveBeenCalled();

  await rerender({ ...props, active: true });
  await waitFor(() => expect(historyCalls(conn)).toBe(3));
  fresh.resolve({ data: toB64(new TextEncoder().encode("fresh-active\n")), seq: 12 });
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 12, { seed: true }));
});

test("streaming roundtrip during online gzip decode cannot enqueue a stale RIS write", async () => {
  const decode = deferred<Uint8Array>();
  const followUp = deferred<{ data: string; seq: number }>();
  gunzipControl.decode = vi.fn(() => decode.promise);
  let call = 0;
  const staleBytes = new TextEncoder().encode("stale-online\n");
  const conn = stubConn(() => {
    call++;
    if (call === 1) return Promise.resolve({
      data: toB64(new TextEncoder().encode("initial\n")), seq: 3,
    });
    if (call === 2) return Promise.resolve({ data: toB64(staleBytes), enc: "gzip", seq: 20 });
    return followUp.promise;
  });
  let term: XTerm | undefined;
  let requestReseed: ((trigger: any) => void) | undefined;
  const props = {
    conn: conn as any, sessionId: "A", active: true, streaming: true,
    onReady: (_id: string, value: XTerm) => { term = value; },
    onReseedReady: (_id: string, fn: (trigger: any) => void) => { requestReseed = fn; },
  };
  const { rerender } = render(Terminal, { props });
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 3, { seed: true }));
  const write = vi.fn();
  (term as any).write = write;
  conn.attach.mockClear();

  requestReseed?.("resync");
  await waitFor(() => expect(gunzipControl.decode).toHaveBeenCalledTimes(1));
  await rerender({ ...props, streaming: false });
  await rerender({ ...props, streaming: true });
  decode.resolve(staleBytes);
  await waitFor(() => expect(historyCalls(conn)).toBe(3));

  expect(write).not.toHaveBeenCalled();
  expect(conn.attach).not.toHaveBeenCalled();
});

test("active roundtrip during online gzip decode cannot enqueue a stale RIS write", async () => {
  const decode = deferred<Uint8Array>();
  const followUp = deferred<{ data: string; seq: number }>();
  gunzipControl.decode = vi.fn(() => decode.promise);
  let call = 0;
  const staleBytes = new TextEncoder().encode("stale-online\n");
  const conn = stubConn(() => {
    call++;
    if (call === 1) return Promise.resolve({
      data: toB64(new TextEncoder().encode("initial\n")), seq: 3,
    });
    if (call === 2) return Promise.resolve({ data: toB64(staleBytes), enc: "gzip", seq: 20 });
    return followUp.promise;
  });
  let term: XTerm | undefined;
  let requestReseed: ((trigger: any) => void) | undefined;
  const props = {
    conn: conn as any, sessionId: "A", active: true, streaming: true,
    onReady: (_id: string, value: XTerm) => { term = value; },
    onReseedReady: (_id: string, fn: (trigger: any) => void) => { requestReseed = fn; },
  };
  const { rerender } = render(Terminal, { props });
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 3, { seed: true }));
  const write = vi.fn();
  (term as any).write = write;

  requestReseed?.("resync");
  await waitFor(() => expect(gunzipControl.decode).toHaveBeenCalledTimes(1));
  await rerender({ ...props, active: false });
  await rerender({ ...props, active: true });
  decode.resolve(staleBytes);
  await waitFor(() => expect(historyCalls(conn)).toBe(3));

  expect(write).not.toHaveBeenCalled();
});

test("active roundtrip during failed initial gzip decode cannot fallback attach", async () => {
  const decode = deferred<Uint8Array>();
  const retry = deferred<{ data: string; seq: number }>();
  gunzipControl.decode = vi.fn(() => decode.promise);
  let call = 0;
  const bytes = new TextEncoder().encode("stale-initial\n");
  const conn = stubConn(() => {
    call++;
    if (call === 1) return Promise.resolve({ data: toB64(bytes), enc: "gzip", seq: 4 });
    return retry.promise;
  });
  const props = { conn: conn as any, sessionId: "A", active: true, streaming: true };
  const { rerender } = render(Terminal, { props });
  await waitFor(() => expect(gunzipControl.decode).toHaveBeenCalledTimes(1));

  await rerender({ ...props, active: false });
  await rerender({ ...props, active: true });
  decode.reject(new Error("decode-failed"));
  await waitFor(() => expect(historyCalls(conn)).toBe(2));

  expect(conn.attach).not.toHaveBeenCalled();
});

test("resyncs queued during offline recovery drain once after commit and attach", async () => {
  const offline = deferred<{ data: string; seq: number }>();
  const online = deferred<{ data: string; seq: number }>();
  let call = 0;
  const conn = stubConn(() => {
    call++;
    if (call === 1) return Promise.resolve({
      data: toB64(new TextEncoder().encode("initial\n")), seq: 3,
    });
    if (call === 2) return offline.promise;
    return online.promise;
  });
  let term: XTerm | undefined;
  let requestReseed: ((trigger: any) => void) | undefined;
  const props = {
    conn: conn as any, sessionId: "A", active: true, streaming: true,
    onReady: (_id: string, value: XTerm) => { term = value; },
    onReseedReady: (_id: string, fn: (trigger: any) => void) => { requestReseed = fn; },
  };
  const { rerender } = render(Terminal, { props });
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 3, { seed: true }));
  await rerender({ ...props, streaming: false });
  conn.attach.mockClear();

  const commits: Array<() => void> = [];
  (term as any).write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
    if (callback) commits.push(callback);
  });
  await rerender({ ...props, streaming: true });
  expect(historyCalls(conn)).toBe(2);
  requestReseed?.("resync");
  requestReseed?.("resync");
  expect(historyCalls(conn)).toBe(2);

  offline.resolve({ data: toB64(new TextEncoder().encode("offline-fresh\n")), seq: 30 });
  await waitFor(() => expect(commits).toHaveLength(1));
  expect(historyCalls(conn)).toBe(2);
  commits[0]();
  await waitFor(() => expect(historyCalls(conn)).toBe(3));

  expect(conn.attach).toHaveBeenCalledWith("A", 30, { seed: true });
  await tick();
  expect(historyCalls(conn)).toBe(3);
});

test("rapid stop and resume never overlaps same-terminal history requests", async () => {
  const pending: Array<ReturnType<typeof deferred<{ data: string; seq: number }>>> = [];
  const conn = stubConn(() => {
    const next = deferred<{ data: string; seq: number }>();
    pending.push(next);
    return next.promise;
  });
  const props = { conn: conn as any, sessionId: "A", active: true, streaming: true };
  const { rerender } = render(Terminal, { props });
  await tick();
  expect(historyCalls(conn)).toBe(1);

  await rerender({ ...props, streaming: false });
  await rerender({ ...props, streaming: true });
  await tick();
  expect(historyCalls(conn)).toBe(1);

  pending[0].resolve({ data: toB64(new TextEncoder().encode("stale\n")), seq: 40 });
  await tick();
  expect(historyCalls(conn)).toBe(2);

  pending[1].resolve({ data: toB64(new TextEncoder().encode("fresh\n")), seq: 41 });
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 41, { seed: true }));
});

test("an initial retry due during online recovery runs after that recovery", async () => {
  vi.useFakeTimers();
  try {
    const online = deferred<{ data: string; seq: number }>();
    let call = 0;
    const conn = stubConn(() => {
      call++;
      if (call === 1) return Promise.reject(new Error("initial-offline"));
      if (call === 2) return online.promise;
      return Promise.resolve({ data: toB64(new TextEncoder().encode("retry-seed\n")), seq: 52 });
    });
    let requestReseed: ((trigger: any) => void) | undefined;
    render(Terminal, {
      props: {
        conn: conn as any,
        sessionId: "A",
        active: true,
        streaming: true,
        onReseedReady: (_id: string, fn: (trigger: any) => void) => { requestReseed = fn; },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(historyCalls(conn)).toBe(1);

    requestReseed?.("resync");
    await vi.advanceTimersByTimeAsync(1000);
    expect(historyCalls(conn)).toBe(2);

    online.resolve({ data: toB64(new TextEncoder().encode("online\n")), seq: 51 });
    await vi.advanceTimersByTimeAsync(100);
    expect(historyCalls(conn)).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});
