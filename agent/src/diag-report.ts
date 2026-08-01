// Client-side diagnostics, sanitised and written to the agent's stdout.
//
// Why this exists (docs/bug/终端显示异常2): the blank-glyph failure only happens
// on a real phone returning from the background, which is exactly the situation
// where no computer is at hand to open devtools. The agent runs on the user's
// own machine and launchd already redirects its stdout to
// ~/Library/Logs/pocketshell/agent.out.log, so letting the app post one line per
// foreground event turns "偶现，抓不到" into "复现后去日志里翻".
//
// Everything here is defensive on purpose. The payload comes from a client, and
// the log it lands in is something a user may well paste into a public issue:
//   - WHITELIST, never passthrough. Only the handful of atlas counters that
//     answer the question are kept; terminal contents, paths and anything else
//     the client sends are dropped, not redacted.
//   - One line, always. Newlines are stripped so a report cannot forge another.
//   - Bounded. Lengths and array sizes are capped so a stuck client cannot fill
//     the disk.
//   - Never throws. It is called from the rpc dispatch; a diagnostic that can
//     break the session is worse than no diagnostic.
export const DIAG_PREFIX = "[pocketshell:diag]";

const MAX_TAG = 64;
const MAX_ERROR = 200;
const MAX_ARRAY = 64;

/** Kinds the agent is willing to record. Anything else is logged as "unknown". */
const KINDS = new Set(["atlas"]);

const oneLine = (s: string, max: number) =>
  s.replace(/[\r\n\t]+/g, " ").slice(0, max);

// A non-number becomes 0 rather than being echoed: these arrays are counters,
// so any string in them is either a bug or an injection attempt.
const numArray = (v: unknown): number[] | undefined =>
  Array.isArray(v) ? v.slice(0, MAX_ARRAY).map((n) => (typeof n === "number" && Number.isFinite(n) ? n : 0)) : undefined;

const boolArray = (v: unknown): boolean[] | undefined =>
  Array.isArray(v) ? v.slice(0, MAX_ARRAY).map((b) => b === true) : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Build the single log line for a client diagnostic report.
 *
 * `now` is injected so tests can pin the timestamp.
 */
export function formatDiagReport(input: unknown, now: () => number = Date.now): string {
  const out: Record<string, unknown> = {};
  try {
    out.ts = new Date(now()).toISOString();
  } catch {
    out.ts = null;
  }
  try {
    const p = (input ?? {}) as Record<string, unknown>;
    out.tag = typeof p.tag === "string" ? oneLine(p.tag, MAX_TAG) : "";
    out.kind = typeof p.kind === "string" && KINDS.has(p.kind) ? p.kind : "unknown";
    if (typeof p.hasRenderer === "boolean") out.hasRenderer = p.hasRenderer;
    const pages = num(p.pages);
    if (pages !== undefined) out.pages = pages;
    const pv = numArray(p.pageVersions);
    if (pv) out.pageVersions = pv;
    const tv = numArray(p.textureVersions);
    if (tv) out.textureVersions = tv;
    const pb = boolArray(p.pagesBlank);
    if (pb) out.pagesBlank = pb;
    // pagesBlank on its own cannot tell "the pixels vanished" from "this page was
    // never drawn to" — both read as blank. These two carry that distinction.
    const pg = numArray(p.pageGlyphs);
    if (pg) out.pageGlyphs = pg;
    const pu = boolArray(p.pagesUsed);
    if (pu) out.pagesUsed = pu;
    const plv = num(p.pageLayoutVersion);
    if (plv !== undefined) out.pageLayoutVersion = plv;
    if (typeof p.error === "string") out.error = oneLine(p.error, MAX_ERROR);
  } catch {
    out.kind = "unknown";
  }
  let body: string;
  try {
    body = JSON.stringify(out);
  } catch {
    body = '{"kind":"unknown"}';
  }
  // JSON.stringify already escapes control characters inside strings, so this
  // only guards against a stray raw newline sneaking in some other way.
  return `${DIAG_PREFIX} ${body.replace(/[\r\n]+/g, " ")}`;
}
