// Startup preflight: tmux is our session-persistence backend. If it is missing
// we fail loud with a distro-specific one-liner rather than silently degrading
// or running a package manager on the user's behalf (aligns with the TLS
// missing-cert throw in config.ts).
import { readFileSync } from "node:fs";

export function tmuxInstallHint(osRelease: string, platform: string = process.platform): string {
  if (platform === "darwin") return "brew install tmux";
  const strip = (s: string) => s.trim().replace(/^["']|["']$/g, "").toLowerCase();
  const id = strip(/^ID=(.*)$/m.exec(osRelease)?.[1] ?? "");
  const like = strip(/^ID_LIKE=(.*)$/m.exec(osRelease)?.[1] ?? "");
  const hay = `${id} ${like}`;
  if (/\b(debian|ubuntu)\b/.test(hay)) return "sudo apt install -y tmux";
  if (/\b(fedora|rhel|centos)\b/.test(hay)) return "sudo dnf install -y tmux";
  if (/\barch\b/.test(hay)) return "sudo pacman -S tmux";
  if (/\balpine\b/.test(hay)) return "apk add tmux";
  if (/\b(suse|opensuse)\b/.test(hay)) return "sudo zypper install tmux";
  return "please install tmux with your package manager, then re-run";
}

export interface EnsureTmuxDeps {
  probe: () => boolean;         // true if `tmux -V` succeeds
  readOsRelease: () => string;  // contents of /etc/os-release, "" if absent
  platform?: string;
  fail: (msg: string) => never; // print + exit(1)
}

export function ensureTmux(deps: EnsureTmuxDeps): void {
  if (deps.probe()) return;
  const hint = tmuxInstallHint(deps.readOsRelease(), deps.platform ?? process.platform);
  deps.fail(
    `[pocketshell] tmux not found — it is required for session persistence.\n` +
    `Install it, then re-run:\n    ${hint}`,
  );
}

export function realTmuxDeps(): EnsureTmuxDeps {
  return {
    probe: () => { try { return Bun.spawnSync(["tmux", "-V"]).exitCode === 0; } catch { return false; } },
    readOsRelease: () => { try { return readFileSync("/etc/os-release", "utf8"); } catch { return ""; } },
    fail: (m) => { console.error(m); process.exit(1); },
  };
}
