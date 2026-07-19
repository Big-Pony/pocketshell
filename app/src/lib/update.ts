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
