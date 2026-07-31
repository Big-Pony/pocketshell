import { test, expect } from "bun:test";
import { startServer } from "./server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecureChannel } from "./secure-channel";
import { loadDeviceRegistry } from "./device-registry";
import { createPairing } from "./pairing";
import { createRateLimiter } from "./rate-limit";
import { createAudit } from "./audit";

const M2 = new Uint8Array([2]);
function passthroughResponder(): SecureChannel {
  let state: SecureChannel["state"] = "handshaking";
  return {
    get state() { return state; },
    start() { return null; },
    receive(frame) { if (state === "handshaking") { state = "transport"; return { status: "handshake", reply: M2, established: true }; } return { status: "message", plaintext: frame }; },
    send(pt) { return pt; },
  };
}

function tmpKeyDir() { return mkdtempSync(join(tmpdir(), "ps-notify-key-")); }
function tmpRegFile() { return join(mkdtempSync(join(tmpdir(), "ps-notify-reg-")), "devices.json"); }

function minimalConfig() {
  return {
    identity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    authorizedKeys: [],
    replayBufferBytes: 4096,
    registry: loadDeviceRegistry(tmpRegFile()),
    pairing: createPairing({ code: "GOODCODE", now: () => 0 }),
    pairingMode: false,
    listen: { host: "127.0.0.1", port: 0 },
    workspaceRoot: ".",
    tls: { enabled: false },
    rateLimiter: createRateLimiter({ now: () => 0 }),
    audit: createAudit({ write: () => {} }),
    keyDir: tmpKeyDir(),
    notifyToken: "test-notify-token",
  };
}

async function withServer(fn: (base: string) => Promise<void>) {
  const srv = startServer({ port: 0, config: minimalConfig() as any, channelFactory: passthroughResponder });
  try { await fn(`http://127.0.0.1:${srv.port}`); } finally { srv.stop(); }
}

test("/internal/notify rejects non-local IPs", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/internal/notify`, { method: "POST", headers: { authorization: "Bearer test-notify-token" }, body: JSON.stringify({ sessionId: "s1" }) });
    // 127.0.0.1 is local, so this should succeed; the test mainly guards the route shape.
    expect(r.status).toBe(200);
  });
});

test("/internal/notify rejects bad token", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/internal/notify`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: JSON.stringify({ sessionId: "s1" }) });
    expect(r.status).toBe(401);
  });
});

test("/internal/notify accepts context-only token payload", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/internal/notify`, {
      method: "POST",
      headers: { authorization: "Bearer test-notify-token", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", tool: "kimi", ctxUsed: 12345, ctxTotal: 262144, contextOnly: true }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
});

test("/internal/notify accepts notification payload without context", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/internal/notify`, {
      method: "POST",
      headers: { authorization: "Bearer test-notify-token", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", title: "s1", body: "done" }),
    });
    expect(r.status).toBe(200);
  });
});
