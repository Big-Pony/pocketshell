import { test, expect } from "vitest";
import { Connection, type WebSocketLike } from "../src/lib/connection";
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

test("queues nothing until open, then flushes newSession + input", () => {
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", wsFactory: () => (ws = new FakeWS()) });
  conn.newSession("s1");
  conn.sendInput("s1", new TextEncoder().encode("hi"));
  expect(ws.sent.length).toBe(0);          // not open yet -> buffered
  ws.open();
  const types = ws.sent.map((r) => JSON.parse(r).type);
  expect(types).toEqual(["newSession", "input"]);
});

test("decodes output frames and delivers decoded bytes", () => {
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  const got: string[] = [];
  conn.onOutput((f) => got.push(new TextDecoder().decode(f.data)));
  ws.emit(encode({ type: "output", sessionId: "s1", seq: 1, data: toB64(new TextEncoder().encode("XYZ")) }));
  expect(got).toEqual(["XYZ"]);
});

import type { SessionMeta } from "../src/lib/protocol";

test("dispatches a sessions frame to onSessions", () => {
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  const got: SessionMeta[][] = [];
  conn.onSessions((s) => got.push(s));
  const meta: SessionMeta = { name: "s1", state: "run", cols: 80, rows: 24, lastLine: "hi", createdAt: 0 };
  ws.emit(encode({ type: "sessions", sessions: [meta] }));
  expect(got).toEqual([[meta]]);
});

test("dispatches exit + error frames", () => {
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", wsFactory: () => (ws = new FakeWS()) });
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
  let ws!: FakeWS;
  const conn = new Connection({ url: "ws://x", wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  conn.listSessions();
  conn.renameSession("s1", "claude");
  const msgs = ws.sent.map((r) => JSON.parse(r));
  expect(msgs).toEqual([
    { type: "listSessions" },
    { type: "renameSession", sessionId: "s1", name: "claude" },
  ]);
});
