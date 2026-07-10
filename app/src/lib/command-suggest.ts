// Rank command hints for the smart hint bar. Pure functions.
function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/**
 * With input: history + catalog entries that start with `line` (case-insensitive),
 * history first, current-input-equal entries dropped. Without input: recent history.
 */
export function suggest(line: string, history: string[], catalog: string[]): string[] {
  if (!line) return dedupe(history);
  const lq = line.toLowerCase();
  const match = (x: string) => x.toLowerCase().startsWith(lq) && x !== line;
  return dedupe([...history.filter(match), ...catalog.filter(match)]);
}

/** Bytes to insert when a hint is tapped: the chosen command minus what's typed. */
export function delta(line: string, chosen: string): string {
  if (chosen.toLowerCase().startsWith(line.toLowerCase())) return chosen.slice(line.length);
  return chosen;
}
