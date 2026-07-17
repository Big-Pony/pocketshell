// macOS TCC warmup (fallback for "grants lost after an update"): probe the
// protected domains right after startup so any authorization prompts cluster
// at boot instead of surprising the user mid-task. Every probe is read-only
// and every failure is silent by design — a denied probe just means macOS
// already decided (prompt shown or grant denied); we never retry or escalate.
//
// Platform boundary: only darwin has TCC. On any other platform runWarmup()
// is a full no-op returning no lines.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { buildFdaGuidance } from "./readiness";

export interface WarmupDeps {
  platform?: string;
  home?: string;
  readdir?: (path: string) => unknown; // throws on denial
  tmux?: (args: string[]) => { exitCode: number };
}

// "Files and Folders" TCC domains — a read here can raise the grant prompt.
const TCC_DIRS = ["Documents", "Desktop", "Downloads"] as const;

const defaultTmux = (args: string[]): { exitCode: number } => {
  try {
    const r = Bun.spawnSync(["tmux", ...args]);
    return { exitCode: r.exitCode ?? 1 };
  } catch {
    return { exitCode: 1 };
  }
};

// Probe everything; return FDA guidance lines when Full Disk Access looks
// missing (FDA can never be prompted programmatically — only detected and
// pointed to), an empty array otherwise.
export function runWarmup(deps: WarmupDeps = {}): string[] {
  if ((deps.platform ?? process.platform) !== "darwin") return [];
  const home = deps.home ?? homedir();
  const readdir = deps.readdir ?? ((p: string) => readdirSync(p));

  for (const d of TCC_DIRS) {
    try { readdir(`${home}/${d}`); } catch { /* denied/absent — nothing to do */ }
  }

  // Spawn-and-kill a scratch tmux session: proves tmux works under the
  // service manager and, when the default cwd sits in a protected folder,
  // pulls the matching file grant into the same boot-time prompt batch.
  const tmux = deps.tmux ?? defaultTmux;
  const scratch = `pocketshell-warmup-${process.pid}`;
  if (tmux(["new-session", "-d", "-s", scratch]).exitCode === 0) {
    tmux(["kill-session", "-t", scratch]);
  }

  // ~/Library/Safari is FDA-gated: readable only with Full Disk Access, and a
  // denied read fails silently (macOS shows no prompt for FDA). Detection only.
  try {
    readdir(`${home}/Library/Safari`);
    return [];
  } catch {
    return buildFdaGuidance();
  }
}
