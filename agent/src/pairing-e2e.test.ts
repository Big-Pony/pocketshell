// S4b end-to-end: real Bun.serve + real WebSocket + real noise-handshake IK,
// exercising the actual authorize() path (real hs.rs -> pending -> registry.add
// -> reconnect authorized). Unit tests use stub responders with a hardcoded
// remoteStatic; this is the only test that drives a real client pubkey through
// pairing into the registry and back as an authorized reconnect.
import { test, expect } from "bun:test";
import { startServer } from "./server";
import { loadConfig } from "./config";
import { encode, decodeServer, type ServerMsg } from "./protocol";
import { toB64 } from "./bytes";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";
import DH from "noise-handshake/dh";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePendingPairing } from "./pairing";

const PRO = Buffer.from("pocketshell-v1");

type ClientKeys = { publicKey: Uint8Array; secretKey: Uint8Array };

// A real IK initiator over a real WebSocket, standing in for the app. Reuses a
// caller-supplied static keypair so a reconnect presents the same identity.
function connectClient(port: number, agentPub: Uint8Array, keys: ClientKeys) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  (ws as any).binaryType = "arraybuffer";
  const hs = new Noise("IK", true, { publicKey: Buffer.from(keys.publicKey), secretKey: Buffer.from(keys.secretKey) });
  hs.initialise(PRO, Buffer.from(agentPub));
  let tx: Cipher | null = null;
  let rx: Cipher | null = null;
  const inbox: (ServerMsg | { established: true })[] = [];
  const waiters: ((m: any) => void)[] = [];
  const deliver = (m: any) => { const w = waiters.shift(); if (w) w(m); else inbox.push(m); };
  ws.onmessage = (ev: any) => {
    const bytes = new Uint8Array(ev.data);
    if (!tx) { hs.recv(Buffer.from(bytes)); tx = new Cipher(hs.tx); rx = new Cipher(hs.rx); deliver({ established: true }); return; }
    deliver(decodeServer(Buffer.from(rx!.decrypt(Buffer.from(bytes))).toString("utf8")));
  };
  let closed = false;
  ws.onclose = () => { if (!closed) { closed = true; deliver({ closed: true }); } };
  return {
    ws,
    clientPubB64: toB64(new Uint8Array(hs.s.publicKey)),
    open: () => new Promise<void>((r) => { ws.onopen = () => { ws.send(hs.send()); r(); }; }),
    next: () => new Promise<any>((r) => { const m = inbox.shift(); if (m) r(m); else waiters.push(r); }),
    send: (obj: any) => ws.send(tx!.encrypt(Buffer.from(encode(obj)))),
    close: () => ws.close(),
  };
}

test("first pair registers the real client pubkey; reconnect connects directly", async () => {
  const keyDir = join(mkdtempSync(join(tmpdir(), "ps-e2e-")), "keys");
  const cfg = loadConfig({ POCKETSHELL_KEY_DIR: keyDir });
  expect(cfg.pairingMode).toBe(true);
  const srv = startServer({ port: 0, config: cfg });

  // stable client identity reused across both connections
  const kp = DH.generateKeyPair();
  const keys: ClientKeys = { publicKey: new Uint8Array(kp.publicKey), secretKey: new Uint8Array(kp.secretKey) };

  // 1) first connect -> pending -> pair with the real code
  const c1 = connectClient(srv.port, cfg.identity.publicKey, keys);
  await c1.open();
  await c1.next(); // established (pending: unregistered pubkey in pairing mode)
  expect(cfg.registry.has(c1.clientPubB64)).toBe(false);
  c1.send({ type: "pair", code: cfg.pairing!.code, deviceName: "iPhone" });
  const paired = await c1.next();
  expect(paired).toEqual({ type: "paired", ok: true });
  expect(cfg.registry.has(c1.clientPubB64)).toBe(true);
  c1.close();

  // 2) reconnect same identity -> now authorized, no pair needed
  const c2 = connectClient(srv.port, cfg.identity.publicKey, keys);
  await c2.open();
  await c2.next(); // established (authorized)
  c2.send({ type: "listSessions" });
  const sess = await c2.next();
  expect(sess.type).toBe("sessions");
  c2.close();

  srv.stop();
  rmSync(keyDir, { recursive: true, force: true });
});

test("once the code is consumed, a new unregistered device is rejected at handshake", async () => {
  const keyDir = join(mkdtempSync(join(tmpdir(), "ps-e2e-")), "keys");
  const cfg = loadConfig({ POCKETSHELL_KEY_DIR: keyDir });
  const srv = startServer({ port: 0, config: cfg });

  // device A pairs successfully -> code consumed
  const kpA = DH.generateKeyPair();
  const a = connectClient(srv.port, cfg.identity.publicKey, { publicKey: new Uint8Array(kpA.publicKey), secretKey: new Uint8Array(kpA.secretKey) });
  await a.open();
  await a.next(); // established (pending)
  a.send({ type: "pair", code: cfg.pairing!.code, deviceName: "iPhone" });
  expect(await a.next()).toEqual({ type: "paired", ok: true });
  a.close();
  expect(cfg.pairing!.isLive()).toBe(false);

  // device B (new identity) now gets rejected at the handshake, not admitted to pending
  const kpB = DH.generateKeyPair();
  const b = connectClient(srv.port, cfg.identity.publicKey, { publicKey: new Uint8Array(kpB.publicKey), secretKey: new Uint8Array(kpB.secretKey) });
  await b.open();
  expect(await b.next()).toEqual({ closed: true }); // rejected -> socket closed, never established
  expect(cfg.registry.has(b.clientPubB64)).toBe(false);

  srv.stop();
  rmSync(keyDir, { recursive: true, force: true });
});

test("wrong code is rejected and does not register the device", async () => {
  const keyDir = join(mkdtempSync(join(tmpdir(), "ps-e2e-")), "keys");
  const cfg = loadConfig({ POCKETSHELL_KEY_DIR: keyDir });
  const srv = startServer({ port: 0, config: cfg });
  const kp = DH.generateKeyPair();
  const keys: ClientKeys = { publicKey: new Uint8Array(kp.publicKey), secretKey: new Uint8Array(kp.secretKey) };

  const c = connectClient(srv.port, cfg.identity.publicKey, keys);
  await c.open();
  await c.next(); // established (pending)
  c.send({ type: "pair", code: "WRONG999", deviceName: "iPhone" });
  const err = await c.next();
  expect(err.type).toBe("error");
  expect(err.code).toBe("pair_failed");
  expect(cfg.registry.has(c.clientPubB64)).toBe(false);
  c.close();

  srv.stop();
  rmSync(keyDir, { recursive: true, force: true });
});

// Regression for the 2026-07-30 field bug: `pocketshell-agent pair` was a
// silent no-op for the first 300s after boot. authorize() only consulted
// pairing.pending.json once the in-memory boot code had died, so a freshly
// minted disk code was ignored and the operator got a misleading bad_code —
// twice in a row during the dev-server install. Drives a real IK handshake so
// the whole authorize -> adoptDiskPairing -> verify path is covered, not just
// the pure predicate.
test("a newer disk-minted code preempts the still-live boot code", async () => {
  const keyDir = join(mkdtempSync(join(tmpdir(), "ps-e2e-")), "keys");
  const cfg = loadConfig({ POCKETSHELL_KEY_DIR: keyDir });
  const srv = startServer({ port: 0, config: cfg });

  // The boot code is alive and unspent — exactly the state right after an
  // `install`, which is when operators reach for `pair`.
  expect(cfg.pairing!.isLive()).toBe(true);
  const bootCode = cfg.pairing!.code;

  // What `pocketshell-agent pair` writes (see runCliDevices in server.ts).
  const diskCode = "ZZZZ7777";
  expect(diskCode).not.toBe(bootCode);
  writePendingPairing(keyDir, {
    code: diskCode,
    expiresAt: Date.now() + 300_000,
    maxAttempts: 5,
    mintedAt: Date.now() + 1_000, // minted after boot
  });

  const kp = DH.generateKeyPair();
  const c = connectClient(srv.port, cfg.identity.publicKey, {
    publicKey: new Uint8Array(kp.publicKey),
    secretKey: new Uint8Array(kp.secretKey),
  });
  await c.open();
  await c.next(); // established (pending)
  c.send({ type: "pair", code: diskCode, deviceName: "iPhone" });
  expect(await c.next()).toEqual({ type: "paired", ok: true });
  expect(cfg.registry.has(c.clientPubB64)).toBe(true);
  c.close();

  srv.stop();
  rmSync(keyDir, { recursive: true, force: true });
});

// The flip side: an OLDER disk record must not resurrect a code the boot
// process already superseded, or a stale pairing.pending.json left on disk
// would keep widening the pairing window after every restart.
test("an older disk-minted code does not displace the live boot code", async () => {
  const keyDir = join(mkdtempSync(join(tmpdir(), "ps-e2e-")), "keys");
  const cfg = loadConfig({ POCKETSHELL_KEY_DIR: keyDir });
  const srv = startServer({ port: 0, config: cfg });
  const bootCode = cfg.pairing!.code;

  writePendingPairing(keyDir, {
    code: "OLDOLD22",
    expiresAt: Date.now() + 300_000,
    maxAttempts: 5,
    mintedAt: Date.now() - 60_000, // minted a minute before this boot
  });

  const kp = DH.generateKeyPair();
  const c = connectClient(srv.port, cfg.identity.publicKey, {
    publicKey: new Uint8Array(kp.publicKey),
    secretKey: new Uint8Array(kp.secretKey),
  });
  await c.open();
  await c.next(); // established (pending)
  c.send({ type: "pair", code: "OLDOLD22", deviceName: "iPhone" });
  const rejected = await c.next();
  expect(rejected.type).toBe("error");
  expect(rejected.code).toBe("pair_failed");
  c.close();

  // …while the boot code still works for a fresh device.
  const kp2 = DH.generateKeyPair();
  const c2 = connectClient(srv.port, cfg.identity.publicKey, {
    publicKey: new Uint8Array(kp2.publicKey),
    secretKey: new Uint8Array(kp2.secretKey),
  });
  await c2.open();
  await c2.next();
  c2.send({ type: "pair", code: bootCode, deviceName: "iPad" });
  expect(await c2.next()).toEqual({ type: "paired", ok: true });
  c2.close();

  srv.stop();
  rmSync(keyDir, { recursive: true, force: true });
});
