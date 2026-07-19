import { test, expect } from "bun:test";
import { createPairing, generatePairingCode } from "./pairing";

test("generatePairingCode returns 8-char uppercase base32", () => {
  const c = generatePairingCode();
  expect(c).toMatch(/^[A-Z2-7]{8}$/);
});

test("correct code once, then consumed", () => {
  let t = 0;
  const p = createPairing({ code: "ABCD2345", ttlMs: 90_000, maxAttempts: 5, now: () => t });
  expect(p.verify("ABCD2345")).toEqual({ ok: true });
  expect(p.verify("ABCD2345")).toEqual({ ok: false, reason: "consumed" });
});

test("expired after ttl", () => {
  let t = 0;
  const p = createPairing({ code: "ABCD2345", ttlMs: 90_000, maxAttempts: 5, now: () => t });
  t = 90_001;
  expect(p.verify("ABCD2345")).toEqual({ ok: false, reason: "expired" });
});

test("wrong code decrements attempts, exhausts to no_attempts", () => {
  let t = 0;
  const p = createPairing({ code: "ABCD2345", ttlMs: 90_000, maxAttempts: 2, now: () => t });
  expect(p.verify("XXXX0000")).toEqual({ ok: false, reason: "bad_code" });
  expect(p.verify("XXXX0000")).toEqual({ ok: false, reason: "bad_code" });
  expect(p.verify("ABCD2345")).toEqual({ ok: false, reason: "no_attempts" });
});

test("isLive is true while fresh, false once consumed / expired / attempts spent", () => {
  let t = 0;
  const consumedP = createPairing({ code: "ABCD2345", ttlMs: 90_000, maxAttempts: 5, now: () => t });
  expect(consumedP.isLive()).toBe(true);
  consumedP.verify("ABCD2345"); // consume
  expect(consumedP.isLive()).toBe(false);

  const expiredP = createPairing({ code: "ABCD2345", ttlMs: 90_000, maxAttempts: 5, now: () => t });
  expect(expiredP.isLive()).toBe(true);
  t = 90_001;
  expect(expiredP.isLive()).toBe(false);

  let u = 0;
  const spentP = createPairing({ code: "ABCD2345", ttlMs: 90_000, maxAttempts: 1, now: () => u });
  spentP.verify("WRONG000"); // last attempt burned
  expect(spentP.isLive()).toBe(false);
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writePendingPairing, readPendingPairing, clearPendingPairing,
} from "./pairing";

test("pending pairing round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-pair-"));
  try {
    const now = 1_000_000;
    writePendingPairing(dir, { code: "ABCD2345", expiresAt: now + 300_000, maxAttempts: 5 });
    const r = readPendingPairing(dir, now);
    expect(r).toEqual({ code: "ABCD2345", expiresAt: now + 300_000, maxAttempts: 5 });
    // expired -> null
    expect(readPendingPairing(dir, now + 300_001)).toBeNull();
    // cleared -> null
    clearPendingPairing(dir);
    expect(readPendingPairing(dir, now)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPendingPairing tolerates a missing/corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-pair-"));
  try {
    expect(readPendingPairing(dir, 0)).toBeNull(); // missing
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
