export function isSupervised(
  env: Record<string, string | undefined> = process.env,
  ppidComm: () => string = defaultPpidComm,
): boolean {
  if (env.INVOCATION_ID) return true;       // systemd
  try { return ppidComm().includes("launchd"); } catch { return false; }
}

function defaultPpidComm(): string {
  try {
    // macOS/Linux: parent process command. launchd is pid 1 / reaper.
    return require("node:child_process").execSync(`ps -o comm= -p ${process.ppid}`, { encoding: "utf8" });
  } catch { return ""; }
}

export function restartSelf(deps: {
  supervised?: boolean;
  execPath?: string;
  argv?: string[];
  spawn?: (cmd: string[], opts: unknown) => void;
  exit?: (code: number) => never;
} = {}): void {
  const supervised = deps.supervised ?? isSupervised();
  const exit = deps.exit ?? ((c: number) => process.exit(c) as never);
  if (supervised) { exit(0); return; }
  const cmd = [deps.execPath ?? process.execPath, ...(deps.argv ?? process.argv.slice(1))];
  const spawn = deps.spawn ?? ((c: string[], o: unknown) => { Bun.spawn(c, o as any); });
  spawn(cmd, { detached: true, stdio: ["ignore", "ignore", "ignore"] });
  exit(0);
}
