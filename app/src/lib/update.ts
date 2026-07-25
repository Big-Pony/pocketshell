// app/src/lib/update.ts
// Pure logic for the OTA update UI: no I/O, no Svelte, no i18n runtime.
export interface CheckResult {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  notes: string;
  publishedAt: string | null;
  canApply: boolean;
  reason?: string;
}

const PHASES = new Set(["downloading", "verifying", "signing", "applying", "restarting", "error"]);

export function phaseLabelKey(phase: string): string {
  return PHASES.has(phase) ? `update.phase.${phase}` : "update.phase.working";
}

function parts(v: string): number[] {
  const s = v.startsWith("v") ? v.slice(1) : v;
  return s.split(".").map((n) => parseInt(n, 10) || 0);
}
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1; if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1; }
  return 0;
}
export function hasUpdate(current: string, latest: string): boolean {
  return compareSemver(current, latest) === -1;
}

/**
 * After an OTA reconnect: should the page clear its caches and reload?
 *
 * Compares the version this frontend was BUILT from against the version the
 * agent is running now — that mismatch is the definition of the stale-frontend
 * bug (the app ships embedded in the agent, so they are meant to be identical).
 *
 * Deliberately not `!hasUpdate`: that only says the agent caught up with the
 * latest GitHub release, which says nothing about whether THIS page is stale.
 *
 * `phase` is the in-flight OTA phase (null when no update was running), so an
 * ordinary reconnect never triggers a reload.
 */
export function shouldReloadAfterUpdate(
  appVersion: string,
  agentVersion: string,
  phase: string | null,
): boolean {
  if (!phase) return false;
  if (!agentVersion) return false;
  return agentVersion !== appVersion;
}
