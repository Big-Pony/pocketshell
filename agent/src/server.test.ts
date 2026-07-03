import { test, expect } from "bun:test";
import { startServer } from "./server";
import type { SecureChannel } from "./secure-channel";
import { encode, decodeServer } from "./protocol";
import { loadDeviceRegistry } from "./device-registry";
import { createPairing } from "./pairing";
import { createRateLimiter } from "./rate-limit";
import { createAudit } from "./audit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const M1 = new Uint8Array([1]);
const M2 = new Uint8Array([2]);
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

function noopAudit() { return createAudit({ write: () => {} }); }
function noopLimiter() { return createRateLimiter({ now: () => 0 }); }

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
    rateLimiter: noopLimiter(), audit: noopAudit(),
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
    rateLimiter: noopLimiter(), audit: noopAudit(),
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

test("authorized: listDevices returns registry + env with self flag", () => {
  const file = tmpRegFile();
  const registry = loadDeviceRegistry(file);
  registry.add("PHONEPUB", "iPhone");
  const cfg: any = {
    identity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    authorizedKeys: ["ENVPUB"], replayBufferBytes: 4096,
    registry, pairing: null, pairingMode: false,
    listen: { host: "127.0.0.1", port: 0 }, workspaceRoot: ".", tls: { enabled: false },
    rateLimiter: noopLimiter(), audit: noopAudit(),
  };
  const srv = startServer({ port: 0, config: cfg, channelFactory: stubResponder("PHONEPUB", false) });
  const ws = fakeWs();
  srv.__test.open(ws as any, "1.2.3.4");
  srv.__test.message(ws as any, M1);
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "listDevices" })));
  const reply: any = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  expect(reply.type).toBe("devices");
  const phone = reply.devices.find((d: any) => d.pubKey === "PHONEPUB");
  const env = reply.devices.find((d: any) => d.pubKey === "ENVPUB");
  expect(phone).toMatchObject({ source: "registry", self: true });
  expect(env).toMatchObject({ source: "env", self: false, lastSeen: null });
  srv.stop();
  rmSync(file, { force: true });
});

test("revokeDevice removes from registry and closes that device's live socket", () => {
  const file = tmpRegFile();
  const registry = loadDeviceRegistry(file);
  registry.add("A", "admin"); registry.add("B", "victim");
  const cfg: any = {
    identity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    authorizedKeys: [], replayBufferBytes: 4096,
    registry, pairing: null, pairingMode: false,
    listen: { host: "127.0.0.1", port: 0 }, workspaceRoot: ".", tls: { enabled: false },
    rateLimiter: noopLimiter(), audit: noopAudit(),
  };
  const srv = startServer({ port: 0, config: cfg, channelFactory: stubResponder("A", false) });
  // admin conn "A"
  const wsA = fakeWs();
  srv.__test.open(wsA as any, "1.1.1.1");
  srv.__test.message(wsA as any, M1);
  // victim conn "B"
  let bClosed = false;
  const wsB: any = { sent: [] as Uint8Array[], send(d: any) { this.sent.push(d); }, close() { bClosed = true; } };
  srv.__test.openWith(wsB, "2.2.2.2", stubResponder("B", false));
  srv.__test.message(wsB as any, M1);
  expect(registry.has("B")).toBe(true);
  srv.__test.message(wsA as any, utf8(encode({ type: "revokeDevice", pubKey: "B" })));
  expect(registry.has("B")).toBe(false);
  expect(bClosed).toBe(true);
  srv.stop();
  rmSync(file, { force: true });
});
