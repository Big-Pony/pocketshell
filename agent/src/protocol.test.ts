import { test, expect } from "bun:test";
import { encode, decodeClient, decodeServer } from "./protocol";

test("pair round-trips through encode/decodeClient", () => {
  const raw = encode({ type: "pair", code: "ABCD1234", deviceName: "iPhone" });
  const msg = decodeClient(raw);
  expect(msg).toEqual({ type: "pair", code: "ABCD1234", deviceName: "iPhone" });
});

test("devices round-trips through encode/decodeServer", () => {
  const devices = [{ pubKey: "p", name: "n", addedAt: "t", lastSeen: null, source: "registry" as const, self: true }];
  const msg = decodeServer(encode({ type: "devices", devices }));
  expect(msg).toEqual({ type: "devices", devices });
});

test("listDevices and revokeDevice round-trips", () => {
  expect(decodeClient(encode({ type: "listDevices" }))).toEqual({ type: "listDevices" });
  expect(decodeClient(encode({ type: "revokeDevice", pubKey: "PK" }))).toEqual({ type: "revokeDevice", pubKey: "PK" });
});

test("paired round-trips", () => {
  expect(decodeServer(encode({ type: "paired", ok: true }))).toEqual({ type: "paired", ok: true });
});

test("snippet messages round-trip", () => {
  expect(decodeClient(encode({ type: "listSnippets" }))).toEqual({ type: "listSnippets" });
  expect(decodeClient(encode({ type: "addSnippet", group: "Git", label: "st", command: "git status", autoEnter: true })))
    .toEqual({ type: "addSnippet", group: "Git", label: "st", command: "git status", autoEnter: true });
  expect(decodeClient(encode({ type: "removeSnippet", id: "x1" }))).toEqual({ type: "removeSnippet", id: "x1" });
  const items = [{ id: "x1", group: "Git", label: "st", command: "git status", autoEnter: true }];
  expect(decodeServer(encode({ type: "snippets", items }))).toEqual({ type: "snippets", items });
});

test("rpc request round-trips through decodeClient", () => {
  const raw = encode({ type: "rpc", id: "7", method: "fs.tree", params: { path: "/tmp" } });
  const msg = decodeClient(raw);
  expect(msg.type).toBe("rpc");
  if (msg.type === "rpc") {
    expect(msg.id).toBe("7");
    expect(msg.method).toBe("fs.tree");
    expect(msg.params).toEqual({ path: "/tmp" });
  }
});

test("ok response round-trips through decodeServer", () => {
  const raw = encode({ type: "response", id: "7", ok: true, result: { a: 1 } });
  const msg = decodeServer(raw);
  expect(msg.type).toBe("response");
  if (msg.type === "response" && msg.ok) expect(msg.result).toEqual({ a: 1 });
});

test("error response round-trips through decodeServer", () => {
  const raw = encode({ type: "response", id: "9", ok: false, error: { code: "enoent", message: "no such file" } });
  const msg = decodeServer(raw);
  expect(msg.type).toBe("response");
  if (msg.type === "response" && !msg.ok) expect(msg.error.code).toBe("enoent");
});

test("rpcChunk round-trips through decodeServer", () => {
  const raw = encode({ type: "rpcChunk", id: "7", index: 1, total: 3, data: "QUJD" });
  const msg = decodeServer(raw);
  expect(msg).toEqual({ type: "rpcChunk", id: "7", index: 1, total: 3, data: "QUJD" });
});

test("update broadcast round-trips", () => {
  const msg = { type: "update", phase: "downloading", pct: 42, version: "0.4.0" } as const;
  const back = decodeServer(encode(msg));
  expect(back).toEqual(msg);
});

test("presence round-trips", () => {
  const m = { type: "presence", foreground: true, activeSessionId: "work" } as const;
  expect(decodeClient(encode(m))).toEqual(m);
});

test("notification round-trips", () => {
  const m = { type: "notification", sessionId: "work", title: "done", body: "ok", ts: 5 } as const;
  expect(decodeServer(encode(m))).toEqual(m);
});

// ---- merged from the former agent/test/protocol.test.ts ----

test("encodes then decodes an input message", () => {
  const raw = encode({ type: "input", sessionId: "s1", data: "aGk=" });
  const msg = decodeClient(raw);
  expect(msg).toEqual({ type: "input", sessionId: "s1", data: "aGk=" });
});

test("decodes an output message from the server side", () => {
  const raw = encode({ type: "output", sessionId: "s1", seq: 7, data: "T0s=" });
  const msg = decodeServer(raw);
  if (msg.type !== "output") throw new Error("wrong type");
  expect(msg.seq).toBe(7);
  expect(msg.sessionId).toBe("s1");
});

test("attach carries optional lastSeq", () => {
  const msg = decodeClient(encode({ type: "attach", sessionId: "s1", lastSeq: 42 }));
  if (msg.type !== "attach") throw new Error("wrong type");
  expect(msg.lastSeq).toBe(42);
});

test("detach carries sessionId (fire-and-forget mirror)", () => {
  const msg = decodeClient(encode({ type: "detach", sessionId: "s1" }));
  expect(msg).toEqual({ type: "detach", sessionId: "s1" });
});

test("decodes a listSessions client message", () => {
  const msg = decodeClient(encode({ type: "listSessions" }));
  expect(msg.type).toBe("listSessions");
});

test("decodes a renameSession client message", () => {
  const msg = decodeClient(encode({ type: "renameSession", sessionId: "s1", name: "claude" }));
  if (msg.type !== "renameSession") throw new Error("wrong type");
  expect(msg.sessionId).toBe("s1");
  expect(msg.name).toBe("claude");
});

test("mirrors ping client message", () => {
  expect(decodeClient(encode({ type: "ping" })).type).toBe("ping");
});

test("mirrors pong server message", () => {
  expect(decodeServer(encode({ type: "pong" })).type).toBe("pong");
});

test("mirrors resync server message with from seq", () => {
  const msg = decodeServer(encode({ type: "resync", sessionId: "s", from: 7 }));
  if (msg.type !== "resync") throw new Error("wrong type");
  expect(msg.from).toBe(7);
});
