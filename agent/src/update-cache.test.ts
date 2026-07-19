import { test, expect } from "bun:test";
import { isFresh, writeCache, readCache } from "./update-cache";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("isFresh within TTL", () => {
  const c = { checkedAt: 1000 } as any;
  expect(isFresh(c, 1000 + 60_000, 6 * 3600_000)).toBe(true);
  expect(isFresh(c, 1000 + 7 * 3600_000, 6 * 3600_000)).toBe(false);
  expect(isFresh(null, 0, 1)).toBe(false);
});

test("write then read round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "psc-"));
  const val = { current: "0.3.0", latest: "0.4.0", hasUpdate: true, notes: "n", publishedAt: null, canApply: true, checkedAt: 42 };
  writeCache(dir, val as any);
  expect(readCache(dir)).toEqual(val as any);
});
