import { test, expect } from "bun:test";
import { startServer, applyGate } from "./server";
import type { SecureChannel } from "./secure-channel";
import { encode, decodeServer } from "./protocol";
import { fromB64 } from "./bytes";
import { loadDeviceRegistry } from "./device-registry";
import { createPairing } from "./pairing";
import { createRateLimiter } from "./rate-limit";
import { createAudit } from "./audit";
import { TerminalService } from "./terminal";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTmux, uniqueSessionName, killSession, waitFor } from "./test-support";

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
// NotificationService (assembled unconditionally in startServer) persists
// VAPID keys/config/subs under config.keyDir — minimal test fixtures below
// need a real writable dir so ensureVapid() doesn't throw on `undefined`.
function tmpKeyDir() { return mkdtempSync(join(tmpdir(), "ps-srv-key-")); }

test("server does not broadcast to a socket that has not completed handshake", () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any);
  srv.__test.broadcastOutputForTest?.();
  expect(ws.sent.length).toBe(0);
  srv.stop();
});

test("after marker handshake, client business frame is dispatched and reply is encrypted-through", async () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any);
  srv.__test.message(ws as any, M1); // handshake msg1 -> reply M2
  expect(ws.sent[0]).toEqual(M2);
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "listSessions" })));
  // list() is async (WP-3a): wait for the probe round + response frame.
  const start = Date.now();
  while (ws.sent.length === 0 && Date.now() - start < 2000) await Bun.sleep(10);
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
    rateLimiter: noopLimiter(), audit: noopAudit(), keyDir: tmpKeyDir(),
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
    rateLimiter: noopLimiter(), audit: noopAudit(), keyDir: tmpKeyDir(),
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
    rateLimiter: noopLimiter(), audit: noopAudit(), keyDir: tmpKeyDir(),
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
    rateLimiter: noopLimiter(), audit: noopAudit(), keyDir: tmpKeyDir(),
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
    rateLimiter: spyLimiter, audit: noopAudit(), keyDir: tmpKeyDir(),
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
    rateLimiter: spyLimiter, audit: noopAudit(), keyDir: tmpKeyDir(),
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
    rateLimiter: noopLimiter(), audit: noopAudit(), keyDir: tmpKeyDir(),
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

test("rpc fs.uploadCheck routes to fs-service and replies with conflicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-rpc-up-"));
  writeFileSync(join(dir, "exists.txt"), "x");
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any);
  srv.__test.message(ws as any, M1);
  ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({
    type: "rpc", id: "42", method: "fs.uploadCheck",
    params: { dir, names: ["exists.txt", "nope.txt"] },
  })));
  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  expect(reply.type).toBe("response");
  if (reply.type === "response" && reply.ok) {
    expect(reply.id).toBe("42");
    expect((reply.result as any).conflicts).toEqual(["exists.txt"]);
  }
  srv.stop();
  rmSync(dir, { recursive: true, force: true });
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

test("periodicPush broadcasts the merged roster (incl. foreign idle sessions)", async () => {
  const utf8b = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
  const okr = (s = "") => ({ exitCode: 0, stdout: utf8b(s), stderr: new Uint8Array() });
  const terminal = new TerminalService({
    tmux: (args) => {
      // Match by subcommand: real calls prefix a global `-u` flag.
      if (args.includes("list-sessions")) return okr("work\t1700000000\t80\t24\n");
      if (args.includes("capture-pane")) return okr("$ vim\n");
      return okr();
    },
  });
  const srv = startServer({ port: 0, channelFactory: passthroughResponder, terminal });
  const ws = fakeWs();
  srv.__test.open(ws as any);
  srv.__test.message(ws as any, M1); // marker handshake -> ready
  ws.sent.length = 0;

  await srv.__test.periodicPush();

  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8")) as any;
  expect(reply.type).toBe("sessions");
  const s = reply.sessions.find((x: any) => x.name === "work");
  expect(s.state).toBe("idle");
  expect(s.attached).toBe(false);
  expect(s.lastLine).toBe("$ vim");
  srv.stop();
});

test("WP-3a: periodicPush diffs against the last broadcast — unchanged roster sends nothing", async () => {
  const utf8b = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
  const okr = (s = "") => ({ exitCode: 0, stdout: utf8b(s), stderr: new Uint8Array() });
  let rosterText = "work\t1700000000\t80\t24\n";
  const terminal = new TerminalService({
    tmux: (args) => {
      if (args.includes("list-sessions")) return okr(rosterText);
      if (args.includes("capture-pane")) return okr("$ vim\n");
      return okr();
    },
  });
  const srv = startServer({ port: 0, channelFactory: passthroughResponder, terminal });
  const ws = fakeWs();
  srv.__test.open(ws as any);
  srv.__test.message(ws as any, M1); // marker handshake -> ready
  ws.sent.length = 0;

  await srv.__test.periodicPush(); // first push: no baseline -> broadcasts
  expect(ws.sent.length).toBe(1);

  await srv.__test.periodicPush(); // identical roster -> diff hit, no frame
  expect(ws.sent.length).toBe(1);

  rosterText = "work\t1700000000\t80\t24\nbuild\t1700000100\t80\t24\n"; // roster changed
  await srv.__test.periodicPush(); // -> diff miss, broadcasts again
  expect(ws.sent.length).toBe(2);

  // listSessions unicast is never gated by the diff cache: request -> answer.
  srv.__test.message(ws as any, utf8(encode({ type: "listSessions" })));
  const start = Date.now();
  while (ws.sent.length === 2 && Date.now() - start < 2000) await Bun.sleep(10);
  expect(ws.sent.length).toBe(3);
  expect(decodeServer(Buffer.from(ws.sent[2]).toString("utf8")).type).toBe("sessions");
  srv.stop();
});


function buildUrl(srv: ReturnType<typeof startServer>, path: string) {
  const u = new URL(srv.url);
  return `http://${u.hostname}:${u.port}${path}`;
}

function realServer(extraConfig: any = {}) {
  const file = tmpRegFile();
  const registry = loadDeviceRegistry(file);
  const base = loadConfig({ registryFile: file });
  const cfg: any = {
    ...base,
    ...extraConfig,
    registry,
    pairing: null,
    pairingMode: false,
    listen: { host: "127.0.0.1", port: 0 },
    tls: { enabled: false },
    rateLimiter: noopLimiter(),
    audit: noopAudit(),
  };
  return { srv: startServer({ port: 0, config: cfg }), file };
}

test("admin page is served on /admin from loopback when enabled", async () => {
  const { srv, file } = realServer({ adminEnabled: true });
  const res = await fetch(buildUrl(srv, "/admin"));
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("PocketShell 本地管理");
  srv.stop();
  rmSync(file, { force: true });
});

test("admin endpoints return 404 when adminEnabled=false", async () => {
  const { srv, file } = realServer({ adminEnabled: false });
  expect((await fetch(buildUrl(srv, "/admin"))).status).toBe(404);
  expect((await fetch(buildUrl(srv, "/admin-api/devices"))).status).toBe(404);
  srv.stop();
  rmSync(file, { force: true });
});

test("admin-api/devices reflects registry devices and online IPs", async () => {
  const { srv, file } = realServer({ adminEnabled: true });
  const reg = srv.__test.config.registry;
  reg.add("PUB1", "iPhone");
  reg.touch("PUB1", "127.0.0.1");
  const res = await fetch(buildUrl(srv, "/admin-api/devices"));
  expect(res.status).toBe(200);
  const rows = await res.json();
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ pubKey: "PUB1", name: "iPhone", online: false, ip: "127.0.0.1" });
  srv.stop();
  rmSync(file, { force: true });
});

test("admin-api/revoke removes a device", async () => {
  const { srv, file } = realServer({ adminEnabled: true });
  const reg = srv.__test.config.registry;
  reg.add("PUB2", "Pixel");
  let deleted = false;
  const res = await fetch(buildUrl(srv, "/admin-api/revoke"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubKey: "PUB2" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(reg.has("PUB2")).toBe(false);
  srv.stop();
  rmSync(file, { force: true });
});

test("admin-api/pair generates a new pairing code", async () => {
  const { srv, file } = realServer({ adminEnabled: true, pairingMode: true });
  const res = await fetch(buildUrl(srv, "/admin-api/pair"), { method: "POST" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.code).toBe("string");
  expect(body.code.length).toBe(8);
  expect(typeof body.pairString).toBe("string");
  expect(body.pairString.length).toBeGreaterThan(0);
  srv.stop();
  rmSync(file, { force: true });
});

// update.apply precondition gate — pure, exported specifically so this can be
// unit-tested without driving the real download/sign/swap/restart pipeline
// (that pipeline is verified manually on real hardware; see
// .superpowers/sdd/task-10-report.md).
test("applyGate: refuses when OTA is disabled (no repo)", () => {
  const out = applyGate(null, { current: "1.0.0", latest: "1.1.0", hasUpdate: true, notes: "", publishedAt: null, canApply: true, checkedAt: Date.now() }, false);
  expect(out).toEqual({ started: false, reason: "disabled" });
});

test("applyGate: refuses when a run is already in progress", () => {
  const out = applyGate("org/repo", { current: "1.0.0", latest: "1.1.0", hasUpdate: true, notes: "", publishedAt: null, canApply: true, checkedAt: Date.now() }, true);
  expect(out).toEqual({ started: false, reason: "in_progress" });
});

test("applyGate: refuses when there is no cached check yet", () => {
  const out = applyGate("org/repo", null, false);
  expect(out).toEqual({ started: false, reason: "no_release_info" });
});

test("applyGate: refuses when the cached check says canApply is false, surfacing its reason", () => {
  const out = applyGate("org/repo", { current: "1.0.0", latest: "1.1.0", hasUpdate: true, notes: "", publishedAt: null, canApply: false, reason: "unsupported_platform", checkedAt: Date.now() }, false);
  expect(out).toEqual({ started: false, reason: "unsupported_platform" });
});

test("applyGate: starts when repo is set, cache is applicable, and nothing is in flight", () => {
  const out = applyGate("org/repo", { current: "1.0.0", latest: "1.1.0", hasUpdate: true, notes: "", publishedAt: null, canApply: true, checkedAt: Date.now() }, false);
  expect(out).toEqual({ started: true, latest: "1.1.0" });
});

// —— 实例身份：serve 层品牌化 ——
function brandFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ps-brand-"));
  writeFileSync(
    join(dir, "manifest.webmanifest"),
    JSON.stringify({ name: "PocketShell", short_name: "PocketShell", id: "/", start_url: "/" }),
  );
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html><head><title>PocketShell</title>' +
      '<meta name="apple-mobile-web-app-title" content="PocketShell" /></head><body></body></html>',
  );
  return dir;
}

function startBranded(instanceName?: string) {
  const dir = brandFixtureDir();
  const keyDir = mkdtempSync(join(tmpdir(), "ps-brandkey-"));
  const env: Record<string, string> = { POCKETSHELL_KEY_DIR: keyDir, POCKETSHELL_PORT: "0" };
  if (instanceName) env.POCKETSHELL_INSTANCE_NAME = instanceName;
  const config = loadConfig(env);
  const srv = startServer({
    port: 0,
    config,
    assets: {
      "/manifest.webmanifest": join(dir, "manifest.webmanifest"),
      "/index.html": join(dir, "index.html"),
    },
  });
  return { srv, dir, keyDir };
}

function cleanupBranded(b: { srv: ReturnType<typeof startServer>; dir: string; keyDir: string }) {
  // startServer's stop() takes no arguments — it already force-closes
  // (server.stop(true)) internally, so the stray `true` was silently dropped.
  b.srv.stop();
  rmSync(b.dir, { recursive: true, force: true });
  rmSync(b.keyDir, { recursive: true, force: true });
}

test("manifest is branded when an instance name is set", async () => {
  const b = startBranded("开发");
  const res = await fetch(`http://127.0.0.1:${b.srv.port}/manifest.webmanifest`);
  const j = await res.json();
  expect(j.name).toBe("开发 · PocketShell");
  expect(j.short_name).toBe("开发");
  cleanupBranded(b);
});

test("index.html title and apple title are branded", async () => {
  const b = startBranded("开发");
  const html = await (await fetch(`http://127.0.0.1:${b.srv.port}/index.html`)).text();
  expect(html).toContain("<title>开发 · PocketShell</title>");
  expect(html).toContain('content="开发"');
  cleanupBranded(b);
});

test("root path / is branded too (it resolves to index.html)", async () => {
  const b = startBranded("开发");
  const html = await (await fetch(`http://127.0.0.1:${b.srv.port}/`, {
    headers: { accept: "text/html" },
  })).text();
  expect(html).toContain("<title>开发 · PocketShell</title>");
  cleanupBranded(b);
});

test("without an instance name the manifest and html are served verbatim", async () => {
  const b = startBranded();
  const res = await fetch(`http://127.0.0.1:${b.srv.port}/manifest.webmanifest`);
  const j = await res.json();
  expect(j.name).toBe("PocketShell");
  expect(j.short_name).toBe("PocketShell");
  const html = await (await fetch(`http://127.0.0.1:${b.srv.port}/index.html`)).text();
  expect(html).toContain("<title>PocketShell</title>");
  cleanupBranded(b);
});

// 「不设实例名 = 逐字节现状」不只是 body：头也不能漂。未品牌化时必须走原来
// 那条 Bun.file 路径，content-type 由 Bun 从扩展名推断（注意 html 那条没有
// 空格：`text/html;charset=utf-8`），品牌化分支手写的 MIME 与之不同。
test("without an instance name the response headers match Bun's own inference", async () => {
  const b = startBranded();
  const m = await fetch(`http://127.0.0.1:${b.srv.port}/manifest.webmanifest`);
  expect(m.headers.get("content-type")).toBe("application/manifest+json");
  const h = await fetch(`http://127.0.0.1:${b.srv.port}/index.html`);
  expect(h.headers.get("content-type")).toBe("text/html;charset=utf-8");
  cleanupBranded(b);
});

// 回归：ETag 必须跟着实例名走，否则改名后手机拿 304 还是旧名字
test("ETag differs between branded and unbranded manifest", async () => {
  const a = startBranded("开发");
  const b = startBranded();
  const ea = (await fetch(`http://127.0.0.1:${a.srv.port}/manifest.webmanifest`)).headers.get("etag");
  const eb = (await fetch(`http://127.0.0.1:${b.srv.port}/manifest.webmanifest`)).headers.get("etag");
  expect(ea).toBeTruthy();
  expect(ea).not.toBe(eb);
  cleanupBranded(a);
  cleanupBranded(b);
});

test("If-None-Match with the branded ETag still yields 304", async () => {
  const b = startBranded("开发");
  const first = await fetch(`http://127.0.0.1:${b.srv.port}/manifest.webmanifest`);
  const etag = first.headers.get("etag")!;
  const second = await fetch(`http://127.0.0.1:${b.srv.port}/manifest.webmanifest`, {
    headers: { "if-none-match": etag },
  });
  expect(second.status).toBe(304);
  cleanupBranded(b);
});

// —— agent.info：照抄上面 `rpc git.status routes through server` 的
// passthroughResponder + fakeWs + srv.__test.message 往返写法，只是换成需要
// 一个带 instanceName 的 config。
function rpcInfoReply(instanceName?: string) {
  const keyDir = mkdtempSync(join(tmpdir(), "ps-info-key-"));
  const env: Record<string, string> = { POCKETSHELL_KEY_DIR: keyDir };
  if (instanceName) env.POCKETSHELL_INSTANCE_NAME = instanceName;
  const srv = startServer({ port: 0, config: loadConfig(env), channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any); srv.__test.message(ws as any, M1); ws.sent.length = 0;
  srv.__test.message(ws as any, utf8(encode({ type: "rpc", id: "i1", method: "agent.info", params: {} })));
  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  srv.stop();
  rmSync(keyDir, { recursive: true, force: true });
  return reply;
}

test("agent.info returns the instance name when set", () => {
  const reply = rpcInfoReply("开发");
  expect(reply.type).toBe("response");
  if (reply.type === "response" && reply.ok) {
    expect(reply.id).toBe("i1");
    expect(reply.result).toEqual({ instanceName: "开发" });
  } else { throw new Error("expected an ok response"); }
});

test("agent.info returns null when no instance name is set", () => {
  const reply = rpcInfoReply();
  expect(reply.type).toBe("response");
  if (reply.type === "response" && reply.ok) {
    expect(reply.result).toEqual({ instanceName: null });
  } else { throw new Error("expected an ok response"); }
});

// —— diag.report：客户端把回前台时的图集状态发回来，agent 打到 stdout（launchd
// 已把 stdout 落盘）。这里验证两件事：走通了、且**只**打白名单字段——线路上
// 的净化归 diag-report.test.ts 逐条覆盖，这条测的是它确实被接上了。
test("diag.report logs one whitelisted line and acks", () => {
  const keyDir = mkdtempSync(join(tmpdir(), "ps-diag-key-"));
  const srv = startServer({ port: 0, config: loadConfig({ POCKETSHELL_KEY_DIR: keyDir }), channelFactory: passthroughResponder });
  const ws = fakeWs();
  srv.__test.open(ws as any); srv.__test.message(ws as any, M1); ws.sent.length = 0;

  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    srv.__test.message(ws as any, utf8(encode({
      type: "rpc", id: "d1", method: "diag.report",
      params: { tag: "s1", kind: "atlas", pages: 1, pageVersions: [3], textureVersions: [3], pagesBlank: [true], buffer: "SECRET" },
    })));
  } finally { console.log = origLog; }

  const reply = decodeServer(Buffer.from(ws.sent[0]).toString("utf8"));
  srv.stop();
  rmSync(keyDir, { recursive: true, force: true });

  expect(reply.type).toBe("response");
  if (reply.type === "response" && reply.ok) {
    expect(reply.result).toEqual({ ok: true });
  } else { throw new Error("expected an ok response"); }

  const diag = lines.filter((l) => l.startsWith("[pocketshell:diag]"));
  expect(diag.length).toBe(1);
  expect(diag[0]).toContain('"pagesBlank":[true]');
  // 终端内容绝不能落进日志（本仓库公开，日志可能被贴进 issue）。
  expect(diag[0]).not.toContain("SECRET");
});

// ---- merged from the former agent/test/server.test.ts ----
// These drive a real WebSocket against the listening port (the tests above use
// the in-process srv.__test hooks). The passthroughResponder / M2 / utf8
// helpers above are reused verbatim — the former file carried an identical copy.

// Helper: open a passthrough-secured WS, perform the marker handshake,
// then return the socket ready for business frames.
// `port` is Bun.Server["port"], which is `number | undefined` (a unix-socket
// server has none). These tests always listen on TCP, so assert rather than
// interpolate `undefined` into the URL and fail with an opaque connect error.
async function openHandshakedWs(port: number | undefined): Promise<WebSocket> {
  if (port == null) throw new Error("server is not listening on a TCP port");
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((res) => (ws.onopen = () => res()));
  // perform marker handshake: send dummy M1, server replies M2 (handshake established)
  await new Promise<void>((res) => {
    ws.onmessage = () => res();
    ws.send(new Uint8Array([1]));
  });
  // switch to text-mode handler for JSON business frames
  ws.onmessage = null;
  return ws;
}

// Helper: send a business frame as binary (UTF-8 encoded JSON) and collect a response
function sendBinary(ws: WebSocket, jsonStr: string) {
  ws.send(new Uint8Array(Buffer.from(jsonStr, "utf8")));
}

// Business-frame messages come back as binary (Uint8Array / ArrayBuffer) in passthrough mode
function parseFrame(ev: MessageEvent): ReturnType<typeof decodeServer> {
  const data = ev.data;
  if (data instanceof ArrayBuffer) return decodeServer(Buffer.from(data).toString("utf8"));
  if (data instanceof Uint8Array) return decodeServer(Buffer.from(data).toString("utf8"));
  return decodeServer(data as string);
}

// Probe via the shared helper: a bare `Bun.spawnSync(["tmux","-V"])` THROWS when
// tmux is absent, which would take down this whole file at collection time.
const hasTmuxWs = hasTmux();

test.skipIf(!hasTmuxWs)("newSession + input round-trips output over WS", async () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  const outputs: string[] = [];
  ws.onmessage = (ev) => {
    const msg = parseFrame(ev);
    if (msg.type === "output") {
      outputs.push(new TextDecoder().decode(fromB64(msg.data)));
    }
  };

  // Unique per process+call: tmux session names are machine-global, so a fixed
  // literal collided with concurrent `bun test` runs (and with a leaked session
  // from a previously failed run). Same defect that made terminal.test.ts flaky.
  const NAME = uniqueSessionName("ws");
  try {
    sendBinary(ws, encode({ type: "newSession", name: NAME }));
    sendBinary(ws, encode({ type: "attach", sessionId: NAME }));
    // Wait for the shell prompt to reach us over the WS instead of sleeping a
    // fixed 400ms — measured, a prompt takes ~600ms even on an idle machine, so
    // input sent at 400ms can be swallowed before the shell is listening.
    expect(await waitFor(() => outputs.length > 0)).toBe(true);
    sendBinary(ws, encode({ type: "input", sessionId: NAME, data: btoa("echo WS_OK\n") }));
    expect(await waitFor(() => outputs.join("").includes("WS_OK"))).toBe(true);
  } finally {
    sendBinary(ws, encode({ type: "kill", sessionId: NAME }));
    await Bun.sleep(100);
    ws.close();
    srv.stop();
    killSession(NAME);
  }
});

test.skipIf(!hasTmuxWs)("newSession broadcasts a sessions frame including the session", async () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  const sessionsFrames: string[][] = [];
  ws.onmessage = (ev) => {
    const msg = parseFrame(ev);
    if (msg.type === "sessions") sessionsFrames.push(msg.sessions.map((s) => s.name));
  };
  const NAME = uniqueSessionName("wssess");
  try {
    sendBinary(ws, encode({ type: "newSession", name: NAME }));
    // Wait for the broadcast rather than sleeping: the sessions frame is what
    // is being asserted, so waiting for it is both faster and load-proof.
    expect(await waitFor(() => sessionsFrames.flat().includes(NAME))).toBe(true);
    sendBinary(ws, encode({ type: "renameSession", sessionId: NAME, name: NAME + "_r" }));
    expect(await waitFor(() => sessionsFrames.flat().includes(NAME + "_r"))).toBe(true);
    const flat = sessionsFrames.flat();
    expect(flat).toContain(NAME);
    expect(flat).toContain(NAME + "_r");
  } finally {
    sendBinary(ws, encode({ type: "kill", sessionId: NAME + "_r" }));
    await Bun.sleep(100);
    ws.close();
    srv.stop();
    killSession(NAME);
    killSession(NAME + "_r");
  }
});

const emptyTmux = () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });

test("listSessions on an empty agent returns an empty sessions frame", async () => {
  const terminal = new TerminalService({ tmux: emptyTmux });
  const srv = startServer({ port: 0, channelFactory: passthroughResponder, terminal });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  // Collect into an array (the idiom the rest of this file uses) rather than a
  // `let x: T | null` the callback reassigns: TS's control-flow analysis cannot
  // see the callback run, so it narrows the variable to `null` at the assert.
  const got: string[][] = [];
  ws.onmessage = (ev) => {
    const msg = parseFrame(ev);
    if (msg.type === "sessions") got.push(msg.sessions.map((s) => s.name));
  };
  sendBinary(ws, encode({ type: "listSessions" }));
  await Bun.sleep(150);
  // `.at(-1)` is undefined when no frame arrived, which still fails the assert.
  expect(got.at(-1)).toEqual([]);
  ws.close();
  srv.stop();
});

test("attach with an evicted lastSeq sends a resync before backfill frames", async () => {
  const { ReplayService } = await import("./replay");
  const replay = new ReplayService(2);
  const enc = new TextEncoder();
  replay.ingest("x", enc.encode("a")); // seq1
  replay.ingest("x", enc.encode("b")); // seq2
  replay.ingest("x", enc.encode("c")); // seq3
  replay.ingest("x", enc.encode("d")); // seq4 -> oldest=3
  const srv = startServer({ port: 0, replay, channelFactory: passthroughResponder });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  const got: any[] = [];
  ws.onmessage = (ev) => got.push(parseFrame(ev));
  sendBinary(ws, encode({ type: "attach", sessionId: "x", lastSeq: 1 }));
  await Bun.sleep(150);
  const resync = got.find((m) => m.type === "resync");
  expect(resync).toEqual({ type: "resync", sessionId: "x", from: 3 });
  const outSeqs = got.filter((m) => m.type === "output").map((m) => m.seq);
  expect(outSeqs).toEqual([3, 4]);
  const resyncIdx = got.findIndex((m) => m.type === "resync");
  const firstOutputIdx = got.findIndex((m) => m.type === "output");
  expect(resyncIdx).toBeLessThan(firstOutputIdx);
  ws.close();
  srv.stop();
});

test("attach within buffer sends no resync", async () => {
  const { ReplayService } = await import("./replay");
  const replay = new ReplayService();
  const enc = new TextEncoder();
  replay.ingest("y", enc.encode("a")); // seq1
  replay.ingest("y", enc.encode("b")); // seq2
  const srv = startServer({ port: 0, replay, channelFactory: passthroughResponder });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  const got: any[] = [];
  ws.onmessage = (ev) => got.push(parseFrame(ev));
  sendBinary(ws, encode({ type: "attach", sessionId: "y", lastSeq: 1 }));
  await Bun.sleep(150);
  expect(got.some((m) => m.type === "resync")).toBe(false);
  expect(got.filter((m) => m.type === "output").map((m) => m.seq)).toEqual([2]);
  ws.close();
  srv.stop();
});

test("ping is answered with pong", async () => {
  const srv = startServer({ port: 0, channelFactory: passthroughResponder });
  const ws = await openHandshakedWs(srv.port);
  ws.binaryType = "arraybuffer";
  const got: any[] = [];
  ws.onmessage = (ev) => got.push(parseFrame(ev));
  sendBinary(ws, encode({ type: "ping" }));
  await Bun.sleep(100);
  expect(got.some((m) => m.type === "pong")).toBe(true);
  ws.close();
  srv.stop();
});
