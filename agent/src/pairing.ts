// A7 Pairing — one-time, TTL-bounded, attempt-limited pairing code. Process-
// level singleton (attempts persist across a client's reconnect attempts).
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

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

// req 7-1: a pending pairing minted by the CLI (`pocketshell-agent pair`) is
// persisted here so an already-running agent can adopt it (server.ts reads it
// in authorize()). File lives beside devices.json; 0600 like other keyDir state.
// mintedAt lets the server tell a *newer* disk code from the in-memory one it
// minted at boot — without it, a code minted while the boot code is still live
// is silently ignored and the user sees a misleading bad_code.
export interface PendingPairingRecord {
  code: string;
  expiresAt: number;
  maxAttempts: number;
  /** Wall-clock ms when the CLI minted this code. Legacy records lack it -> 0. */
  mintedAt?: number;
}

const PENDING_FILE = "pairing.pending.json";

export function writePendingPairing(keyDir: string, rec: PendingPairingRecord): void {
  const path = join(keyDir, PENDING_FILE);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  renameSync(tmp, path); // atomic replace
}

export function readPendingPairing(keyDir: string, now: number): PendingPairingRecord | null {
  try {
    const rec = JSON.parse(readFileSync(join(keyDir, PENDING_FILE), "utf8")) as PendingPairingRecord;
    if (!rec || typeof rec.code !== "string" || typeof rec.expiresAt !== "number") return null;
    if (now > rec.expiresAt) return null;
    // Legacy records (written before mintedAt existed) read as 0, which keeps
    // the old "only adopt once the in-memory code is dead" behaviour for them.
    return { ...rec, mintedAt: typeof rec.mintedAt === "number" ? rec.mintedAt : 0 };
  } catch {
    return null; // missing or corrupt — treat as no pending pairing
  }
}

export function clearPendingPairing(keyDir: string): void {
  try { unlinkSync(join(keyDir, PENDING_FILE)); } catch { /* absent is fine */ }
}

// Decides whether a disk-minted pending code should replace the one the agent
// minted in memory at boot. Pure so the rule is unit-tested rather than buried
// in server.ts wiring.
//
// Both codes are same-origin (writing pairing.pending.json needs write access
// to keyDir, i.e. local privilege), so preferring the newer one does not widen
// the attack surface; brute force stays bounded by rate-limit.ts at handshake.
export function shouldAdoptDiskPairing(i: {
  memoryLive: boolean;
  memoryMintedAt: number;
  diskMintedAt: number;
}): boolean {
  if (!i.memoryLive) return true;             // nothing live to protect
  return i.diskMintedAt > i.memoryMintedAt;   // a newer explicit mint wins
}
