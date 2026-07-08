// Decide whether a UTF-8 LANG fallback is needed for `base` (e.g. process.env
// or a tmux-server env). Returns "en_US.UTF-8" only when NONE of LC_ALL /
// LC_CTYPE / LANG are set, so an explicit user locale is always respected.
// Shared by ptyEnv() (the attach-client process env) and terminal.ts (the
// tmux `new-session` server env, which is what actually determines the
// locale pane programs like vim see — see terminal.ts for details).
export function cjkFallbackLang(base: Record<string, string | undefined>): string | null {
  const hasLocale = base.LC_ALL || base.LC_CTYPE || base.LANG;
  return hasLocale ? null : "en_US.UTF-8";
}

// Build the env for the PTY subprocess. Keep TERM correct for tmux's terminfo,
// and ensure a UTF-8 locale so CJK input in pane programs (vim/shell) is not
// garbled under launchd's C locale — but never override a locale the user set.
export function ptyEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.TERM = "xterm-256color";
  const lang = cjkFallbackLang(base);
  if (lang) env.LANG = lang;
  return env;
}
