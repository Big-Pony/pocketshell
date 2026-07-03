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
