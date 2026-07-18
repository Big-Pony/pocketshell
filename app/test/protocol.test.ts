import { test, expect } from "vitest";
import { toB64, fromB64 } from "../src/lib/bytes";
import { encode, decodeServer, decodeClient } from "../src/lib/protocol";

test("browser base64 round-trips non-UTF8 bytes", () => {
  const src = new Uint8Array([0, 27, 91, 255, 65]);
  expect(Array.from(fromB64(toB64(src)))).toEqual(Array.from(src));
});

test("decodes a server output frame", () => {
  const msg = decodeServer(encode({ type: "output", sessionId: "s", seq: 3, data: "QQ==" }));
  if (msg.type !== "output") throw new Error("wrong type");
  expect(msg.seq).toBe(3);
});

test("mirrors renameSession client message", () => {
  const msg = decodeClient(encode({ type: "renameSession", sessionId: "s", name: "n" }));
  if (msg.type !== "renameSession") throw new Error("wrong type");
  expect(msg.name).toBe("n");
});

test("mirrors listSessions client message", () => {
  expect(decodeClient(encode({ type: "listSessions" })).type).toBe("listSessions");
});

test("mirrors ping client message", () => {
  expect(decodeClient(encode({ type: "ping" })).type).toBe("ping");
});

test("mirrors detach client message", () => {
  const msg = decodeClient(encode({ type: "detach", sessionId: "s" }));
  if (msg.type !== "detach") throw new Error("wrong type");
  expect(msg.sessionId).toBe("s");
});

test("mirrors pong + resync server messages", () => {
  expect(decodeServer(encode({ type: "pong" })).type).toBe("pong");
  const r = decodeServer(encode({ type: "resync", sessionId: "s", from: 3 }));
  if (r.type !== "resync") throw new Error("wrong type");
  expect(r.from).toBe(3);
});

test("mirrors rpcChunk server message (WP-6)", () => {
  const msg = decodeServer(encode({ type: "rpcChunk", id: "7", index: 2, total: 5, data: "QQ==" }));
  if (msg.type !== "rpcChunk") throw new Error("wrong type");
  expect(msg.id).toBe("7");
  expect(msg.index).toBe(2);
  expect(msg.total).toBe(5);
  expect(msg.data).toBe("QQ==");
});
