import { test, expect } from "bun:test";
import { startServer } from "./server";
import type { SecureChannel } from "./secure-channel";
import { encode, decodeServer } from "./protocol";
import { loadDeviceRegistry } from "./device-registry";
import { createPairing } from "./pairing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// responder stub that reports a fixed remoteStatic and pending flag
function stubResponder(remoteStatic: string, pending: boolean): () => SecureChannel {
  return () => {
    let state: SecureChannel["state"] = "handshaking";
    return {
      get state() { return state; },
      start() { return null; },
      receive(frame) {
        if (state === "handshaking") { state = "transport"; return { status: "handshake", reply: M2, established: true, remoteStatic, pending }; }
        return { status: "message", plaintext: frame };
      },
      send(pt) { return pt; },
    };
  };
}

// minimal fake ServerWebSocket capturing binary sends
function fakeWs() {
  const sent: Uint8Array[] = [];
  return { sent, send(d: Uint8Array | string) { sent.push(typeof d === "string" ? utf8(d) : d); }, close() {} };
}

function tmpRegFile() { return join(mkdtempSync(join(tmpdir(), "ps-srv-")), "devices.json"); }

test("server does not broadcast to a socket that has not completed handshake", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any);
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
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "listSessions" })));
  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  expect(reply.type).toBe("sessions");
  srv.stop();
});

test("pending connection: pair with correct code registers device + replies paired", () => {
  const file = tmpRegFile();
  const registry = loadDeviceRegistry(file);
  const pairing = createPairing({ code: "GOODCODE", now: () => 0 });
  const cfg: any = {
    identity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    authorizedKeys: [], replayBufferBytes: 4096,
    registry, pairing, pairingMode: true,
    listen: { host: "127.0.0.1", port: 0 }, workspaceRoot: ".", tls: { enabled: false },
  };
  const srv = startServer({ port: 0, config: cfg, channelFactory: stubResponder("PHONEPUB", true) });
  const ws = fakeWs();
  srv.__test.open(ws as any, "1.2.3.4");
  srv.__test.message(ws as any, M1); // handshake -> pending
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "pair", code: "GOODCODE", deviceName: "iPhone" })));
  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  expect(reply).toEqual({ type: "paired", ok: true });
  expect(registry.has("PHONEPUB")).toBe(true);
  srv.stop();
  rmSync(file, { force: true });
});

test("pending connection: non-pair message closes the socket", () => {
  const file = tmpRegFile();
  const registry = loadDeviceRegistry(file);
  const pairing = createPairing({ code: "GOODCODE", now: () => 0 });
  const cfg: any = {
    identity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    authorizedKeys: [], replayBufferBytes: 4096,
    registry, pairing, pairingMode: true,
    listen: { host: "127.0.0.1", port: 0 }, workspaceRoot: ".", tls: { enabled: false },
  };
  let closed = false;
  const srv = startServer({ port: 0, config: cfg, channelFactory: stubResponder("PHONEPUB", true) });
  const ws: any = { sent: [] as Uint8Array[], send(d: any) { this.sent.push(d); }, close() { closed = true; } };
  srv.__test.open(ws as any, "1.2.3.4");
  srv.__test.message(ws as any, M1);
  srv.__test.message(ws as any, utf8(encode({ type: "listSessions" })));
  expect(closed).toBe(true);
  expect(registry.has("PHONEPUB")).toBe(false);
  srv.stop();
  rmSync(file, { force: true });
});
