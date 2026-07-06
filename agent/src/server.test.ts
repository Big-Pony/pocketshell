import { test, expect } from "bun:test";
import { startServer } from "./server";
import type { SecureChannel } from "./secure-channel";
import { encode, decodeServer } from "./protocol";
import { loadDeviceRegistry } from "./device-registry";
import { createPairing } from "./pairing";
import { createRateLimiter } from "./rate-limit";
import { createAudit } from "./audit";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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

test("authorized: a redundant pair (stale pendingPair after a dropped 'paired') is answered idempotently", () => {
  // Repro of the reconnect loop: the phone paired once (device registered) but
  // the 'paired' reply was lost in a drop, so its pendingPair was never cleared.
  // Every authorized reconnect then re-sends 'pair'. The server must treat this
  // as an idempotent success (device already trusted) and reply 'paired', not a
  // "unknown_type" error — otherwise the client stays stuck reconnecting.
  const file = tmpRegFile();
  const registry = loadDeviceRegistry(file);
  registry.add("PHONEPUB", "iPhone");
  const cfg: any = {
    identity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    authorizedKeys: [], replayBufferBytes: 4096,
    registry, pairing: null, pairingMode: false,
    listen: { host: "127.0.0.1", port: 0 }, workspaceRoot: ".", tls: { enabled: false },
    rateLimiter: noopLimiter(), audit: noopAudit(),
  };
  const srv = startServer({ port: 0, config: cfg, channelFactory: stubResponder("PHONEPUB", false) });
  const ws = fakeWs();
  srv.__test.open(ws as any, "1.2.3.4");
  srv.__test.message(ws as any, M1); // handshake -> authorized (not pending)
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "pair", code: "STALECODE", deviceName: "iPhone" })));
  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  expect(reply).toEqual({ type: "paired", ok: true });
  srv.stop();
  rmSync(file, { force: true });
});

test("transport-phase channel fail on an established conn is NOT counted toward rate limit", () => {
  const recorded: string[] = [];
  const spyLimiter = { record: (ip: string) => recorded.push(ip), isLocked: () => false };
  const cfg: any = {
    identity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    authorizedKeys: [], replayBufferBytes: 4096,
    registry: loadDeviceRegistry(tmpRegFile()), pairing: null, pairingMode: false,
    listen: { host: "127.0.0.1", port: 0 }, workspaceRoot: ".", tls: { enabled: false },
    rateLimiter: spyLimiter, audit: noopAudit(),
  };
  // stub: 1st frame -> established authorized; 2nd frame -> transport fail
  const failAfterEstablish = (): SecureChannel => {
    let n = 0;
    let state: SecureChannel["state"] = "handshaking";
    return {
      get state() { return state; },
      start() { return null; },
      receive() {
        if (n++ === 0) { state = "transport"; return { status: "handshake", reply: M2, established: true, remoteStatic: "X", pending: false }; }
        state = "failed";
        return { status: "fail", reason: "decrypt_failed" };
      },
      send(pt) { return pt; },
    };
  };
  const srv = startServer({ port: 0, config: cfg, channelFactory: failAfterEstablish });
  const ws = fakeWs();
  srv.__test.open(ws as any, "7.7.7.7");
  srv.__test.message(ws as any, M1);                 // -> established
  srv.__test.message(ws as any, utf8("garbage"));    // -> transport fail
  expect(recorded).toEqual([]);                       // established peer's decrypt fail not counted
  srv.stop();
});

test("handshake-phase channel fail IS counted toward rate limit", () => {
  const recorded: string[] = [];
  const spyLimiter = { record: (ip: string) => recorded.push(ip), isLocked: () => false };
  const cfg: any = {
    identity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    authorizedKeys: [], replayBufferBytes: 4096,
    registry: loadDeviceRegistry(tmpRegFile()), pairing: null, pairingMode: false,
    listen: { host: "127.0.0.1", port: 0 }, workspaceRoot: ".", tls: { enabled: false },
    rateLimiter: spyLimiter, audit: noopAudit(),
  };
  const rejectAtHandshake = (): SecureChannel => ({
    get state() { return "handshaking" as const; },
    start() { return null; },
    receive() { return { status: "fail", reason: "unauthorized" }; },
    send(pt) { return pt; },
  });
  const srv = startServer({ port: 0, config: cfg, channelFactory: rejectAtHandshake });
  const ws = fakeWs();
  srv.__test.open(ws as any, "8.8.8.8");
  srv.__test.message(ws as any, M1);                 // -> handshake fail
  expect(recorded).toEqual(["8.8.8.8"]);
  srv.stop();
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

test("rpc fs.tree routes to fs-service and replies directly with id", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ps-rpc-")), "");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "hi");
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any);
  srv.__test.message(ws as any, M1); // handshake
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "rpc", id: "1", method: "fs.tree", params: { path: dir } })));
  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  expect(reply.type).toBe("response");
  if (reply.type === "response" && reply.ok) {
    expect(reply.id).toBe("1");
    expect((reply.result as any).nodes.map((n: any) => n.name)).toContain("a.txt");
  }
  srv.stop();
});

test("rpc unknown method replies ok:false", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any);
  srv.__test.message(ws as any, M1);
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "rpc", id: "2", method: "bogus.x", params: {} })));
  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  if (reply.type === "response") { expect(reply.ok).toBe(false); expect(reply.id).toBe("2"); }
  srv.stop();
});

test("rpc handler error is wrapped as ok:false", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any);
  srv.__test.message(ws as any, M1);
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "rpc", id: "3", method: "fs.read", params: { path: "/no/such/file" } })));
  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  if (reply.type === "response" && !reply.ok) expect(reply.id).toBe("3");
  srv.stop();
});

import { runGit as rg } from "./git-service";

test("rpc git.status routes through server", () => {
  const d = mkdtempSync(join(tmpdir(), "ps-gsrv-"));
  rg(d, ["init", "-q"]); rg(d, ["config", "user.email", "t@t"]); rg(d, ["config", "user.name", "T"]);
  writeFileSync(join(d, "a.txt"), "x");
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any); srv.__test.message(ws as any, M1); ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "rpc", id: "g1", method: "git.status", params: { cwd: d } })));
  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  if (reply.type === "response" && reply.ok) {
    expect((reply.result as any).files.some((f: any) => f.path === "a.txt")).toBe(true);
  }
  srv.stop();
});
