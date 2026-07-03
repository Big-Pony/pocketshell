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
