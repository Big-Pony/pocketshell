import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "./update-check";

export interface CachedCheck extends CheckResult { checkedAt: number }

export const CHECK_TTL_MS = 6 * 60 * 60 * 1000;

function file(keyDir: string): string { return join(keyDir, "update-cache.json"); }

export function readCache(keyDir: string): CachedCheck | null {
  const f = file(keyDir);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")) as CachedCheck; } catch { return null; }
}

export function writeCache(keyDir: string, c: CachedCheck): void {
  try { writeFileSync(file(keyDir), JSON.stringify(c), { mode: 0o600 }); } catch { /* best-effort */ }
}

export function isFresh(cache: CachedCheck | null, now: number, ttlMs: number): boolean {
  return !!cache && now - cache.checkedAt < ttlMs;
}
