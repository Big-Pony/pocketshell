// Pure parser for the `pocketshell-agent notify` subcommand. Each agent tool
// hands the completion payload differently: Codex passes JSON as argv[0]
// (last-assistant-message), Claude Code pipes a hook JSON on stdin, opencode's
// plugin may pass nothing. Returns null when POCKETSHELL_NOTIFY_SESSION is
// absent (not a PocketShell session -> the caller exits 0 without POSTing).
export interface NotifyPayload { sessionId: string; title: string; body: string; }

export function parseNotifyPayload(
  env: Record<string, string | undefined>, argv: string[], stdin: string,
): NotifyPayload | null {
  const sessionId = env.POCKETSHELL_NOTIFY_SESSION;
  if (!sessionId) return null;
  let body = "";
  const tryJson = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };
  const fromArgv = argv[0] ? tryJson(argv[0]) : null;
  const fromStdin = stdin ? tryJson(stdin) : null;
  const j = fromArgv ?? fromStdin;
  if (j && typeof j === "object") {
    body = String(j["last-assistant-message"] ?? j.message ?? j.body ?? j.text ?? "");
  } else if (stdin.trim()) {
    body = stdin.trim();
  }
  return { sessionId, title: sessionId, body };
}
