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
