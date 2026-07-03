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

test("mirrors pong + resync server messages", () => {
  expect(decodeServer(encode({ type: "pong" })).type).toBe("pong");
  const r = decodeServer(encode({ type: "resync", sessionId: "s", from: 3 }));
  if (r.type !== "resync") throw new Error("wrong type");
  expect(r.from).toBe(3);
});
