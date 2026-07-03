import { test, expect } from "bun:test";
import { startServer } from "./server";
import type { SecureChannel } from "./secure-channel";
import { encode, decodeServer } from "./protocol";

const M1 = new Uint8Array([1]);
const M2 = new Uint8Array([2]);
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

// passthrough responder: no crypto, frames pass as-is after a marker handshake
function passthroughResponder(): SecureChannel {
  let state: SecureChannel["state"] = "handshaking";
  return {
    get state() { return state; },
    start() { return null; },
    receive(frame) {
      if (state === "handshaking") { state = "transport"; return { status: "handshake", reply: M2, established: true }; }
      return { status: "message", plaintext: frame };
    },
    send(pt) { return pt; },
  };
}

// minimal fake ServerWebSocket capturing binary sends
function fakeWs() {
  const sent: Uint8Array[] = [];
  return { sent, send(d: Uint8Array | string) { sent.push(typeof d === "string" ? utf8(d) : d); }, close() {} };
}

test("server does not broadcast to a socket that has not completed handshake", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any);
  // before handshake: a listSessions attempt would be ignored (not ready)
  // simulate an output broadcast; ready=false so nothing is sent
  srv.__test.broadcastOutputForTest?.();
  expect(ws.sent.length).toBe(0);
  srv.stop();
});

test("after marker handshake, client business frame is dispatched and reply is encrypted-through", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any);
  srv.__test.message(ws as any, M1); // handshake msg1 -> reply M2
  expect(ws.sent[0]).toEqual(M2);
  // now transport: send a listSessions request as plaintext JSON bytes
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "listSessions" })));
  // server replies with a sessions frame (passthrough => plaintext JSON bytes)
  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  expect(reply.type).toBe("sessions");
  srv.stop();
});
