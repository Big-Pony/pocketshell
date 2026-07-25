// app/src/lib/sw-cache.ts
// Pure caching rules shared (by convention) with public/sw.js. No I/O, no
// Svelte, no DOM — so vitest can cover the whole decision table.
//
// IMPORTANT: public/sw.js is copied verbatim by vite (no bundling, no imports),
// so it carries a hand-mirrored copy of these rules. Change one, change both.
// Same arrangement as index.html's inline theme guard <-> lib/theme.ts.

export type CacheStrategy = "cache-first" | "network-first" | "bypass";

/** Cache bucket name prefix. Every bucket we own starts with this. */
export const BUCKET_PREFIX = "ps-v";

/** Cache bucket for a given app version, e.g. "1.0.1" -> "ps-v1.0.1". */
export function bucketName(version: string): string {
  return `${BUCKET_PREFIX}${version}`;
}

// Cache-first prefixes: content-hashed bundles plus assets that only change
// with a release (fonts/icons are fixed files under public/).
const CACHE_FIRST_PREFIXES = ["/assets/", "/fonts/", "/icons/"];
// Cache-first exact paths.
const CACHE_FIRST_EXACT = new Set(["/manifest.webmanifest"]);
// The shell: always try the network so the app never boots a stale entry point.
const NETWORK_FIRST_EXACT = new Set(["/", "/index.html"]);

/**
 * Decide how a same-origin GET should be handled. Allowlist by design: anything
 * not explicitly listed bypasses the cache, so a future route (a new token-authed
 * endpoint, say) can't be cached by accident.
 */
export function cacheStrategy(pathname: string): CacheStrategy {
  if (NETWORK_FIRST_EXACT.has(pathname)) return "network-first";
  if (CACHE_FIRST_EXACT.has(pathname)) return "cache-first";
  for (const p of CACHE_FIRST_PREFIXES) if (pathname.startsWith(p)) return "cache-first";
  return "bypass";
}

/** Bucket names we own that aren't the current version — safe to delete. */
export function staleBuckets(keys: string[], currentVersion: string): string[] {
  const keep = bucketName(currentVersion);
  return keys.filter((k) => k.startsWith(BUCKET_PREFIX) && k !== keep);
}
