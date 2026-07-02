import { test, expect } from "bun:test";
import { encode, decodeClient, decodeServer } from "../src/protocol";

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
