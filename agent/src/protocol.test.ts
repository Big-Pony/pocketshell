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
