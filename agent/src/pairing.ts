// A7 Pairing — one-time, TTL-bounded, attempt-limited pairing code. Process-
// level singleton (attempts persist across a client's reconnect attempts).
import { randomBytes } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generatePairingCode(): string {
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += B32[b[i] & 31];
  return s;
}

export interface Pairing {
  readonly code: string;
  // True while the code can still succeed: not consumed, not expired, attempts
  // remain. authorize() gates the pending window on this so unregistered peers
  // stop being admitted once the code is spent — not for the whole process life.
  isLive(): boolean;
  verify(code: string): { ok: true } | { ok: false; reason: "expired" | "consumed" | "no_attempts" | "bad_code" };
}

export function createPairing(opts: { code?: string; ttlMs?: number; maxAttempts?: number; now: () => number }): Pairing {
  const code = opts.code ?? generatePairingCode();
  const expiresAt = opts.now() + (opts.ttlMs ?? 300_000);
  let attemptsLeft = opts.maxAttempts ?? 5;
  let consumed = false;
  return {
    get code() { return code; },
    isLive() { return !consumed && opts.now() <= expiresAt && attemptsLeft > 0; },
    verify(input) {
      if (consumed) return { ok: false, reason: "consumed" };
      if (opts.now() > expiresAt) return { ok: false, reason: "expired" };
      if (attemptsLeft <= 0) return { ok: false, reason: "no_attempts" };
      if (input !== code) { attemptsLeft--; return { ok: false, reason: "bad_code" }; }
      consumed = true;
      return { ok: true };
    },
  };
}
