// Resolve the local notification endpoint for hooks launched from a shell that
// predates PocketShell's environment injection (common after an Agent restart).
// The fallback is deliberately tmux-only: a global Codex hook run in an ordinary
// terminal must remain a no-op instead of notifying an unrelated session.
import type { AgentConfig } from "./config";

export interface NotifyRuntime {
  sessionId: string;
  url: string;
  token: string;
}

export interface NotifyRuntimeDeps {
  tmuxSession(pane: string): string | null;
  loadConfig(): Pick<AgentConfig, "listen" | "notifyToken">;
}

export function resolveNotifyRuntime(
  env: Record<string, string | undefined>,
  deps: NotifyRuntimeDeps,
): NotifyRuntime | null {
  const seededSession = env.POCKETSHELL_NOTIFY_SESSION;
  const seededUrl = env.POCKETSHELL_NOTIFY_URL;
  const seededToken = env.POCKETSHELL_NOTIFY_TOKEN;
  if (seededSession && seededUrl && seededToken) {
    return { sessionId: seededSession, url: seededUrl, token: seededToken };
  }

  const pane = env.TMUX_PANE;
  if (!pane) return null;
  const sessionId = deps.tmuxSession(pane);
  if (!sessionId) return null;
  try {
    const cfg = deps.loadConfig();
    return {
      sessionId,
      url: `http://127.0.0.1:${cfg.listen.port}/internal/notify`,
      token: cfg.notifyToken,
    };
  } catch { return null; }
}

