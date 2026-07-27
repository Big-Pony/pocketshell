// Rank command hints for the smart hint bar. Pure functions.
/** 顺序保持的去重。suggestSlash 也用它——两处必须是同一份实现。 */
export function dedupe(xs: string[]): string[] {
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
 * With input: history + user-custom + catalog entries that start with `line`
 * (case-insensitive), in that order, current-input-equal entries dropped.
 * Without input: recent history + custom.
 *
 * `custom` 是用户自己维护的联想库（需求 5），排在内置 catalog 之前——他们专门
 * 录了，当然比我们猜的准。
 */
export function suggest(line: string, history: string[], custom: string[], catalog: string[]): string[] {
  if (!line) return dedupe([...history, ...custom]);
  const lq = line.toLowerCase();
  const match = (x: string) => x.toLowerCase().startsWith(lq) && x !== line;
  return dedupe([...history.filter(match), ...custom.filter(match), ...catalog.filter(match)]);
}

/** Bytes to insert when a hint is tapped: the chosen command minus what's typed. */
export function delta(line: string, chosen: string): string {
  if (chosen.toLowerCase().startsWith(line.toLowerCase())) return chosen.slice(line.length);
  return chosen;
}
