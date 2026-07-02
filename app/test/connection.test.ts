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
