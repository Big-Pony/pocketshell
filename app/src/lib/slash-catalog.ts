// Built-in slash-command catalog for the smart hint bar (req 7-2). Static data
// + pure prefix match. Union of Claude Code + Codex commands, CORE tier first
// so the hint bar surfaces the highest-frequency ones. Phone quick-insert, not
// exhaustive and not tool-aware; not user-editable (grow it by editing here).
// Verified against developers.openai.com/codex/cli/slash-commands and
// code.claude.com/docs/en/slash-commands (2026-07-19).
export const SLASH_CATALOG: string[] = [
  // core (12) — highest frequency across both tools
  "/clear", "/compact", "/model", "/review", "/init", "/status",
  "/plan", "/diff", "/new", "/resume", "/context", "/cost",
  // secondary (10)
  "/mcp", "/permissions", "/mention", "/copy", "/vim", "/usage",
  "/agents", "/memory", "/config", "/help",
];

/**
 * Prefix match over SLASH_CATALOG (case-insensitive), catalog order preserved
 * (core tier first). Drops the entry exactly equal to the input, mirroring
 * command-suggest's suggest(). Callers invoke this only when the reconstructed
 * line starts with '/'.
 */
export function suggestSlash(line: string): string[] {
  const lq = line.toLowerCase();
  return SLASH_CATALOG.filter((c) => c.toLowerCase().startsWith(lq) && c !== line);
}
