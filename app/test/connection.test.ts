import { test, expect } from "vitest";
import { Connection, type WebSocketLike, type Scheduler } from "../src/lib/connection";
import { encode } from "../src/lib/protocol";
import { toB64 } from "../src/lib/bytes";

class FakeWS implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.onclose?.(); }
  emit(raw: string) { this.onmessage?.({ data: raw }); }
  open() { this.onopen?.(); }
}

function makeFakeScheduler() {
  let t = 0;
  let nextId = 1;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  const sched: Scheduler = {
    setTimeout: (fn, ms) => { const id = nextId++; timeouts.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { every: ms, next: t + ms, fn }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    now: () => t,
  };
  function advance(ms: number) {
    const target = t + ms;
    while (true) {
      let due: { id: number; at: number; kind: "t" | "i" } | null = null;
      for (const [id, x] of timeouts) if (x.at <= target && (!due || x.at < due.at)) due = { id, at: x.at, kind: "t" };
      for (const [id, x] of intervals) if (x.next <= target && (!due || x.next < due.at)) due = { id, at: x.next, kind: "i" };
      if (!due) break;
      t = due.at;
      if (due.kind === "t") { const x = timeouts.get(due.id)!; timeouts.delete(due.id); x.fn(); }
      else { const x = intervals.get(due.id)!; x.next += x.every; x.fn(); }
    }
    t = target;
  }
  return { sched, advance };
}

test("status starts connecting, goes online on open, offline on close", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const seen: string[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()) });
  conn.onStatus((s) => seen.push(s));
  expect(conn.status).toBe("connecting");
  ws.open();
  expect(conn.status).toBe("online");
  ws.close();
  expect(conn.status).toBe("offline");
  expect(seen).toEqual(["online", "offline"]);
  conn.dispose?.();
});

test("queues nothing until open, then flushes newSession + input", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()) });
  conn.newSession("s1");
  conn.sendInput("s1", new TextEncoder().encode("hi"));
  expect(ws.sent.length).toBe(0);          // not open yet -> buffered
  ws.open();
  const types = ws.sent.map((r) => JSON.parse(r).type);
  expect(types).toEqual(["newSession", "input"]);
});

test("decodes output frames and delivers decoded bytes", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  const got: string[] = [];
  conn.onOutput((f) => got.push(new TextDecoder().decode(f.data)));
  ws.emit(encode({ type: "output", sessionId: "s1", seq: 1, data: toB64(new TextEncoder().encode("XYZ")) }));
  expect(got).toEqual(["XYZ"]);
});

import type { SessionMeta } from "../src/lib/protocol";

test("dispatches a sessions frame to onSessions", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  const got: SessionMeta[][] = [];
  conn.onSessions((s) => got.push(s));
  const meta: SessionMeta = { name: "s1", state: "run", cols: 80, rows: 24, lastLine: "hi", createdAt: 0 };
  ws.emit(encode({ type: "sessions", sessions: [meta] }));
  expect(got).toEqual([[meta]]);
});

test("dispatches exit + error frames", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  const exits: number[] = [];
  const errs: string[] = [];
  conn.onExit((f) => exits.push(f.code));
  conn.onError((f) => errs.push(f.code));
  ws.emit(encode({ type: "exit", sessionId: "s1", code: 137 }));
  ws.emit(encode({ type: "error", code: "boom", message: "bad" }));
  expect(exits).toEqual([137]);
  expect(errs).toEqual(["boom"]);
});

test("listSessions + renameSession are sent once open", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  conn.listSessions();
  conn.renameSession("s1", "claude");
  const msgs = ws.sent.map((r) => JSON.parse(r));
  expect(msgs).toEqual([
    { type: "listSessions" },
    { type: "renameSession", sessionId: "s1", name: "claude" },
  ]);
});

test("setStatus does not re-notify on the same status", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()) });
  const seen: string[] = [];
  conn.onStatus((s) => seen.push(s));
  ws.open();
  ws.open(); // second onopen -> setStatus("online") again, must be deduped
  expect(seen.filter((s) => s === "online").length).toBe(1);
  conn.dispose?.();
});

test("tracks max seq per session and attaches with it", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  ws.emit(encode({ type: "output", sessionId: "s1", seq: 5, data: toB64(new Uint8Array([65])) }));
  ws.emit(encode({ type: "output", sessionId: "s1", seq: 4, data: toB64(new Uint8Array([66])) })); // out-of-order lower, ignored for max
  ws.sent.length = 0;
  conn.attach("s1");
  expect(JSON.parse(ws.sent[0])).toEqual({ type: "attach", sessionId: "s1", lastSeq: 5 });
});

test("dispatches resync frames to onResync", () => {
  const { sched } = makeFakeScheduler();
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  const got: any[] = [];
  conn.onResync((f) => got.push(f));
  ws.emit(encode({ type: "resync", sessionId: "s1", from: 9 }));
  expect(got).toEqual([{ sessionId: "s1", from: 9 }]);
});

test("reconnects after close with exponential backoff", () => {
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; } });
  created[0].open();
  expect(conn.status).toBe("online");
  created[0].close();
  expect(conn.status).toBe("offline");
  advance(500);                 // first backoff = 500ms
  expect(created.length).toBe(2); // a new socket was created
  created[1].open();
  expect(conn.status).toBe("online");
  conn.dispose();
});

test("ignores stale socket callbacks after reconnect", () => {
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; } });
  created[0].open();
  created[0].close();
  advance(500);
  created[1].open();
  const seen: string[] = [];
  conn.onStatus((s) => seen.push(s));
  created[0].close();           // stale socket fires again -> must be ignored
  expect(conn.status).toBe("online");
  expect(seen).toEqual([]);
  conn.dispose();
});

test("re-attaches all attached sessions with lastSeq on reconnect", () => {
  const { sched, advance } = makeFakeScheduler();
  const created: FakeWS[] = [];
  const conn = new Connection({ url: "ws://x", scheduler: sched, wsFactory: () => { const w = new FakeWS(); created.push(w); return w; } });
  created[0].open();
  conn.attach("s1");
  conn.attach("s2");
  created[0].emit(encode({ type: "output", sessionId: "s1", seq: 3, data: toB64(new Uint8Array([65])) }));
  created[0].close();
  advance(500);
  created[1].open();
  const msgs = created[1].sent.map((r) => JSON.parse(r));
  expect(msgs).toContainEqual({ type: "attach", sessionId: "s1", lastSeq: 3 });
  expect(msgs).toContainEqual({ type: "attach", sessionId: "s2", lastSeq: 0 });
  expect(msgs.some((m) => m.type === "listSessions")).toBe(true);
  conn.dispose();
});
