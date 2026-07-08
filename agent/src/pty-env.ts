// Build the env for the PTY subprocess. Keep TERM correct for tmux's terminfo,
// and ensure a UTF-8 locale so CJK input in pane programs (vim/shell) is not
// garbled under launchd's C locale — but never override a locale the user set.
export function ptyEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.TERM = "xterm-256color";
  const hasLocale = base.LC_ALL || base.LC_CTYPE || base.LANG;
  if (!hasLocale) env.LANG = "en_US.UTF-8";
  return env;
}
