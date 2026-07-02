import { test, expect } from "vitest";
import { toB64, fromB64 } from "../src/lib/bytes";
import { encode, decodeServer } from "../src/lib/protocol";

test("browser base64 round-trips non-UTF8 bytes", () => {
  const src = new Uint8Array([0, 27, 91, 255, 65]);
  expect(Array.from(fromB64(toB64(src)))).toEqual(Array.from(src));
});

test("decodes a server output frame", () => {
  const msg = decodeServer(encode({ type: "output", sessionId: "s", seq: 3, data: "QQ==" }));
  if (msg.type !== "output") throw new Error("wrong type");
  expect(msg.seq).toBe(3);
});
