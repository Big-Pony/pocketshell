// Built-in slash-command catalog for the smart hint bar (req 7-2). Static data
// + pure prefix match. Union of Claude Code + Codex commands, CORE tier first
// so the hint bar surfaces the highest-frequency ones. Phone quick-insert, not
// exhaustive and not tool-aware; not user-editable (grow it by editing here).
// Verified against developers.openai.com/codex/cli/slash-commands and
// code.claude.com/docs/en/slash-commands (2026-07-19).
import { dedupe } from "./command-suggest";

export const SLASH_CATALOG: string[] = [
  // core (12) — highest frequency across both tools
  "/clear", "/compact", "/model", "/review", "/init", "/status",
  "/plan", "/diff", "/new", "/resume", "/context", "/cost",
  // secondary (10)
  "/mcp", "/permissions", "/mention", "/copy", "/vim", "/usage",
  "/agents", "/memory", "/config", "/help",
];

/**
 * Prefix match over user-custom entries then SLASH_CATALOG (case-insensitive),
 * catalog order preserved (core tier first). Drops the entry exactly equal to
 * the input, mirroring command-suggest's suggest(). Callers invoke this only
 * when the reconstructed line starts with '/'.
 *
 * 必须 dedupe：用户自定义了与内置同名的斜杠命令（如 /clear）时，不去重会渲染
 * 出两个一样的 chip。与 suggest() 共用同一份 dedupe 实现。
 */
export function suggestSlash(line: string, custom: string[]): string[] {
  const lq = line.toLowerCase();
  const match = (c: string) => c.toLowerCase().startsWith(lq) && c !== line;
  return dedupe([...custom.filter(match), ...SLASH_CATALOG.filter(match)]);
}
