// Cross-process device-registry sync.
//
// `pocketshell-agent devices remove <fp>` runs in its own process: it loads the
// registry from disk, rewrites devices.json, and exits. The resident agent read
// that file once at boot and never looks again, so before this module the CLI
// removal did nothing observable — the device stayed in the agent's in-memory
// registry, kept passing authorize(), and the next heartbeat's touch() wrote
// the "removed" record straight back to disk. The docs claimed the CLI replaced
// the admin page for headless boxes; it did not.
//
// Polling, not fs.watch. Measured on macOS: watching the file reports 3 events
// for 2 atomic writes (harmless — reload is idempotent), but watching the
// directory MISSED one of them entirely. devices.json is rewritten via
// tmp+rename, which swaps the inode, and inotify/FSEvents disagree about what
// that means for an existing watch. A stat() every few seconds costs nothing,
// behaves identically on both platforms, and is testable with an injected clock
// instead of a sleep.
import { statSync } from "node:fs";

/** Cheap change token. mtime alone misses same-millisecond rewrites, so size
 *  rides along — a device add/remove almost always changes the length. */
export interface FileStamp { mtimeMs: number; size: number }

export function readStamp(file: string): FileStamp | null {
  try {
    const st = statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null; // missing file: treated as "no change to report"
  }
}

export function stampsEqual(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * Which public keys disappeared between two registry snapshots.
 *
 * Only removals matter here. An *added* device needs no action from the agent:
 * authorize() consults the live registry, and a device the CLI added is one the
 * operator vouched for. A *removed* device is the security-relevant direction —
 * it must lose its connection, its push subscriptions, and its authorization.
 */
export function removedKeys(before: readonly string[], after: readonly string[]): string[] {
  const kept = new Set(after);
  return before.filter((k) => !kept.has(k));
}

export interface RegistryWatchDeps {
  /** Current on-disk stamp. */
  stamp: () => FileStamp | null;
  /** Re-read the registry from disk and return the resulting pubkey list. */
  reload: () => string[];
  /** Pubkeys currently in the agent's in-memory registry. */
  current: () => string[];
  /** Called once per pubkey that vanished: close conns, drop push subs, audit. */
  onRemoved: (pubKeys: string[]) => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  intervalMs?: number;
}

/** 3s: a revoked device should lose access promptly, but this is a stat() on a
 *  small file — the cost is irrelevant at this cadence and the operator is not
 *  watching a stopwatch. */
export const REGISTRY_POLL_MS = 3_000;

/**
 * Poll the registry file; on change, reload and report removals.
 *
 * Returns a stop function. The caller (server.ts) owns the reaction — this
 * module deliberately knows nothing about connections, push, or audit so the
 * decision logic above stays pure.
 */
export interface RegistryWatchHandle {
  stop(): void;
  /** Run one poll synchronously. Lets tests assert the reaction without
   *  sleeping through the interval. */
  poll(): void;
}

export function watchRegistryFile(deps: RegistryWatchDeps): RegistryWatchHandle {
  const si = deps.setInterval ?? setInterval;
  const ci = deps.clearInterval ?? clearInterval;
  let last = deps.stamp();

  const tick = () => {
    const now = deps.stamp();
    if (stampsEqual(last, now)) return;
    last = now;
    const before = deps.current();
    const after = deps.reload();
    const gone = removedKeys(before, after);
    if (gone.length) deps.onRemoved(gone);
  };

  const h = si(tick, deps.intervalMs ?? REGISTRY_POLL_MS);
  // Never hold the process open for a background poll: an agent whose only
  // remaining work is this timer should still be able to exit.
  (h as unknown as { unref?: () => void }).unref?.();
  return { stop: () => ci(h), poll: tick };
}
