import { test, expect } from "bun:test";
import { createRateLimiter } from "./rate-limit";

test("locks an ip after maxFailures within window; onLock fires once", () => {
  let t = 0;
  const locked: string[] = [];
  const rl = createRateLimiter({ windowMs: 60_000, maxFailures: 3, lockMs: 300_000, now: () => t, onLock: (ip) => locked.push(ip) });
  rl.record("1.1.1.1"); rl.record("1.1.1.1");
  expect(rl.isLocked("1.1.1.1")).toBe(false);
  rl.record("1.1.1.1"); // 3rd
  expect(rl.isLocked("1.1.1.1")).toBe(true);
  expect(locked).toEqual(["1.1.1.1"]);
});

test("failures outside window do not accumulate", () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 60_000, maxFailures: 3, lockMs: 300_000, now: () => t });
  rl.record("2.2.2.2"); rl.record("2.2.2.2");
  t = 60_001; // window rolled
  rl.record("2.2.2.2");
  expect(rl.isLocked("2.2.2.2")).toBe(false);
});

test("lock expires after lockMs", () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 60_000, maxFailures: 1, lockMs: 300_000, now: () => t });
  rl.record("3.3.3.3");
  expect(rl.isLocked("3.3.3.3")).toBe(true);
  t = 300_001;
  expect(rl.isLocked("3.3.3.3")).toBe(false);
});
