// req: side-effecting half of the install/uninstall subcommands. Every pure
// decision lives in cli-install.ts; this file only touches the filesystem and
// spawns the supervisor CLIs.
//
// House rule for this file: never build a shell command string. Always pass an
// argv array to Bun.spawn. A `sudo -S` + pipe combination silently swallowed a
// heredoc during the 2026-07-30 manual install and still exited 0 — argv arrays
// make that class of failure impossible.
import { existsSync, copyFileSync, writeFileSync, readFileSync, mkdirSync, realpathSync, chmodSync, rmSync, symlinkSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseInstallArgv, resolvePlan,
  LINUX_BIN_DIR, LINUX_SYMLINK,
  type InstallPlan,
} from "./cli-install";
import { renderUnitFor } from "./cli-tunnel";
import { ensureTmux, realTmuxDeps } from "./ensure-tmux";

const PAIR_RE = /pocketshell-pair:[A-Za-z0-9_-]+/g;

/** Last pairing token in a log blob, or null. Newest wins after a restart. */
export function extractPairingString(log: string): string | null {
  const all = log.match(PAIR_RE);
  return all && all.length > 0 ? all[all.length - 1] : null;
}

export function backupPath(unitPath: string, stamp: string): string {
  return `${unitPath}.bak.${stamp}`;
}

function stampNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface RunResult { code: number; stdout: string; stderr: string }

async function run(cmd: string[]): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function homeOfUser(user: string): string | null {
  // getent is the portable way to read passwd on Linux (works with LDAP/SSSD too).
  const r = Bun.spawnSync(["getent", "passwd", user]);
  if (r.exitCode !== 0) return null;
  const fields = r.stdout.toString().trim().split(":");
  return fields[5] || null;
}

function tmuxDirOf(): string | null {
  const r = Bun.spawnSync(["which", "tmux"]);
  if (r.exitCode !== 0) return null;
  const p = r.stdout.toString().trim();
  return p ? dirname(p) : null;
}

// Replaces dst with a copy of src, unlinking dst first.
//
// Writing over a file that some process is currently executing fails with
// ETXTBSY on Linux — which is exactly what a reinstall does, since the running
// service is executing the target. unlink only detaches the directory entry:
// the running process keeps the old inode alive until it exits, and the copy
// lands on a fresh inode. (install.sh has always done this; the TS path
// regressed on it and died with a raw Bun stack trace during the 2026-07-30
// acceptance run.)
export function replaceBinary(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  rmSync(dst, { force: true });
  copyFileSync(src, dst);
  chmodSync(dst, 0o755);
}

/** True when `link` is a symlink already resolving to `target`. */
export function symlinkTargetOk(link: string, target: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && readlinkSync(link) === target;
  } catch {
    return false; // absent, or a regular file that must be replaced
  }
}

/** Copies the running binary into place, skipping a no-op self-copy. */
function installBinary(plan: InstallPlan): string[] {
  const lines: string[] = [];
  const src = realpathSync(process.execPath);
  const alreadyThere = existsSync(plan.binPath) && realpathSync(plan.binPath) === src;
  if (alreadyThere) {
    // Copying a file onto itself truncates the running binary to 0 bytes.
    lines.push(`Binary is already at the target path, skipping copy: ${plan.binPath}`);
  } else {
    replaceBinary(src, plan.binPath);
    lines.push(`Installed binary: ${plan.binPath}`);
  }
  // Hand the binary's directory to the service user: OTA writes a temp file
  // beside the binary and renames over it, which needs directory write access
  // (v1.6.0 shipped it root-owned and OTA died with EACCES).
  if (plan.binOwner) {
    const dir = dirname(plan.binPath);
    const r = Bun.spawnSync(["chown", "-R", `${plan.binOwner}:`, dir]);
    if (r.exitCode === 0) lines.push(`Handed ${dir} to ${plan.binOwner} (in-app updates need to write there)`);
    else lines.push(`Warning: chown ${dir} failed; in-app updates may fail for lack of permission`);
  }
  // Keep the command on the global PATH — `sudo pocketshell-agent uninstall`
  // resolves through root's PATH, which does not include the install dir.
  if (plan.symlinkPath && !symlinkTargetOk(plan.symlinkPath, plan.binPath)) {
    mkdirSync(dirname(plan.symlinkPath), { recursive: true });
    rmSync(plan.symlinkPath, { force: true }); // may be a stale real binary
    symlinkSync(plan.binPath, plan.symlinkPath);
    lines.push(`Linked command: ${plan.symlinkPath} -> ${plan.binPath}`);
  }
  return lines;
}

/** Writes the unit, backing up any existing one first. Returns log lines. */
function writeUnit(plan: InstallPlan): string[] {
  const lines: string[] = [];
  const text = renderUnitFor(plan);
  if (existsSync(plan.unitPath)) {
    const bak = backupPath(plan.unitPath, stampNow());
    copyFileSync(plan.unitPath, bak);
    lines.push(`Backed up the existing service config: ${bak}`);
  }
  mkdirSync(dirname(plan.unitPath), { recursive: true });
  writeFileSync(plan.unitPath, text, { mode: 0o644 });
  lines.push(`Wrote service config: ${plan.unitPath}`);
  return lines;
}

/** Polls the agent's HTTP port until it answers, or the deadline passes. */
async function waitReady(host: string, port: number, timeoutMs = 15_000): Promise<boolean> {
  // 0.0.0.0 is a bind wildcard, not a connectable address.
  const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${target}:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return true;
    } catch { /* not up yet */ }
    await Bun.sleep(500);
  }
  return false;
}

async function readServiceLog(plan: InstallPlan): Promise<string> {
  if (plan.platform === "linux") {
    const r = await run(["journalctl", "-u", plan.label, "--since", "-2 min", "-o", "cat", "--no-pager"]);
    return r.stdout;
  }
  const path = plan.logPath!;
  try { return await Bun.file(path).text(); } catch { return ""; }
}

function printSuccess(plan: InstallPlan, pairing: string | null, paired: number): void {
  const appUrl = plan.env.POCKETSHELL_ADVERTISE
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://");
  console.log("");
  console.log(`✓ PocketShell is installed as a system service and starts on boot.`);
  console.log("");
  console.log(`  service user  ${plan.user}`);
  console.log(`  key dir       ${plan.keyDir}`);
  console.log(`  app URL       ${appUrl}`);
  console.log("");
  if (pairing) {
    console.log(`Open that URL on your phone and paste this pairing string (valid for 300s):`);
    console.log("");
    console.log(`  ${pairing}`);
  } else if (paired > 0) {
    // Not a failure: the agent deliberately skips minting a boot code when the
    // registry is non-empty, so no string exists to print. Pointing at the log
    // here would send the operator hunting for something never written.
    console.log(`This machine already has ${paired} paired device(s) — they keep working, no need to pair again.`);
    console.log(`To add another phone, run:`);
    console.log(`  ${plan.binPath} pair`);
  } else {
    console.log(`The service started, but the pairing string could not be captured automatically. Check it manually:`);
    console.log(plan.platform === "linux"
      ? `  journalctl -u ${plan.label} -n 30`
      : `  tail -n 30 ${plan.logPath}`);
  }
  console.log("");
  console.log(`Need a public address so your phone can reach this from outside?`);
  console.log(`  No domain:  sudo pocketshell-agent tunnel setup`);
  console.log(`  Have one:   https://github.com/Big-Pony/pocketshell/blob/main/DEPLOYMENT.md`);
  console.log("");
  console.log(`Uninstall: pocketshell-agent uninstall`);
}

export async function runInstall(argv: string[]): Promise<number> {
  const action = parseInstallArgv(argv);
  if (action.cmd === "error") { console.error(action.message); return 1; }
  if (action.cmd !== "install") { console.error("internal error: runInstall received a non-install action"); return 1; }

  // --- read-only phase: nothing below this point has touched the system yet ---
  const r = resolvePlan({
    platform: process.platform,
    euid: typeof process.geteuid === "function" ? process.geteuid() : 0,
    env: process.env,
    opts: action.opts,
    homeOf: homeOfUser,
    tmuxDir: tmuxDirOf,
  });
  if (!r.ok) { console.error(r.message); return 1; }
  const plan = r.plan;

  // tmux is the session-persistence backend; fail loud rather than install a
  // service that would exit on first start.
  ensureTmux(realTmuxDeps());

  if (plan.user === "root" && plan.platform === "linux") {
    console.log("Note: the service will run as root, so a connected phone gets a root shell.");
    console.log("      To use a regular account, re-run with --user <username>.");
  }

  // --- mutating phase ---
  for (const l of installBinary(plan)) console.log(l);
  for (const l of writeUnit(plan)) console.log(l);

  if (plan.platform === "linux") {
    const reload = await run(["systemctl", "daemon-reload"]);
    if (reload.code !== 0) { console.error(`systemctl daemon-reload failed:\n${reload.stderr}`); return 1; }
    const up = await run(["systemctl", "enable", "--now", plan.label]);
    if (up.code !== 0) {
      console.error(`Failed to start the service:\n${up.stderr}`);
      const st = await run(["systemctl", "status", plan.label, "--no-pager", "-l"]);
      console.error(st.stdout.split("\n").slice(-20).join("\n"));
      return 1;
    }
    console.log(`Enabled and started the service: ${plan.label}.service`);
  } else {
    return await bootstrapLaunchd(plan);
  }

  const ready = await waitReady(plan.env.POCKETSHELL_HOST, Number(plan.env.POCKETSHELL_PORT));
  if (!ready) {
    console.error(`The service is registered, but did not respond on ${plan.env.POCKETSHELL_HOST}:${plan.env.POCKETSHELL_PORT} within 15s.`);
    console.error(`View logs: journalctl -u ${plan.label} -n 30`);
    return 1;
  }
  // Read the code the service minted at boot. Do NOT call the `pair`
  // subcommand here: server.ts only adopts a disk-minted code when it is newer
  // than the in-memory one, and a just-booted agent always holds a live boot
  // code — asking `pair` at this moment produced two bogus bad_code failures
  // during the 2026-07-30 manual install.
  printSuccess(plan, extractPairingString(await readServiceLog(plan)), pairedDeviceCount(plan.keyDir));
  return 0;
}

export function launchdDomain(uid: number): string {
  return `gui/${uid}`;
}

// How many devices are already paired against this keyDir. Drives the wording
// after install: config.ts only turns pairingMode on when the registry is
// empty, so on a machine that already has devices the agent never mints a boot
// code and no pairing string will ever appear in the log. Telling the operator
// to go read journalctl there (as the first cut did) sends them looking for
// something that was never written.
export function pairedDeviceCount(keyDir: string): number {
  try {
    const j = JSON.parse(readFileSync(join(keyDir, "devices.json"), "utf8"));
    return Array.isArray(j?.devices) ? j.devices.length : 0;
  } catch {
    return 0; // missing or corrupt -> treat as a fresh install
  }
}

/** The binary path a systemd unit launches, or null. */
export function execStartFromUnit(unitText: string): string | null {
  const m = /^ExecStart=(.+)$/m.exec(unitText);
  return m ? m[1].trim() : null;
}

// Recovers the service's real keyDir from the unit about to be removed. Both
// formats are covered: systemd's `Environment=KEY=value` and launchd's
// `<key>KEY</key><string>value</string>`.
//
// Why not just derive it from HOME: uninstall runs under sudo on Linux, so the
// calling process's HOME is root's while the service runs as someone else. The
// 2026-07-30 acceptance run printed "密钥目录 /root/.pocketshell" (the CLI was
// Chinese back then; it now prints "key dir") for a service whose keys actually
// lived in /home/myt/.pocketshell — a path that did not even exist. Returns
// null when the unit predates this field, so the caller can
// fall back to a generic hint instead of inventing a path.
export function keyDirFromUnit(unitText: string): string | null {
  const systemd = /^Environment=POCKETSHELL_KEY_DIR=(.+)$/m.exec(unitText);
  if (systemd) return systemd[1].trim();
  const launchd = /<key>POCKETSHELL_KEY_DIR<\/key>\s*<string>([^<]*)<\/string>/.exec(unitText);
  if (launchd) return launchd[1].trim();
  return null;
}

async function bootstrapLaunchd(plan: InstallPlan): Promise<number> {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const domain = launchdDomain(uid);
  mkdirSync(dirname(plan.logPath!), { recursive: true });
  // bootout first so a re-install picks up the new plist; a missing service is
  // not an error here (exit code ignored on purpose).
  await run(["launchctl", "bootout", `${domain}/${plan.label}`]);
  const boot = await run(["launchctl", "bootstrap", domain, plan.unitPath]);
  if (boot.code !== 0) {
    console.error(`launchctl bootstrap failed:\n${boot.stderr || boot.stdout}`);
    return 1;
  }
  console.log(`Registered and started the service: ${plan.label}`);

  const ready = await waitReady(plan.env.POCKETSHELL_HOST, Number(plan.env.POCKETSHELL_PORT));
  if (!ready) {
    console.error(`The service is registered, but did not respond on ${plan.env.POCKETSHELL_HOST}:${plan.env.POCKETSHELL_PORT} within 15s.`);
    console.error(`View logs: tail -n 30 ${plan.logPath}`);
    return 1;
  }
  printSuccess(plan, extractPairingString(await readServiceLog(plan)), pairedDeviceCount(plan.keyDir));
  return 0;
}

export async function runUninstall(): Promise<number> {
  const platform = process.platform;
  if (platform === "linux") {
    if (typeof process.geteuid === "function" && process.geteuid() !== 0) {
      console.error("uninstall needs root. Run it as: sudo pocketshell-agent uninstall");
      return 1;
    }
    const unitPath = "/etc/systemd/system/pocketshell.service";
    if (!existsSync(unitPath)) { console.log("No installed service found; nothing to uninstall."); return 0; }
    // Read the keyDir out before deleting the unit — it is the only record of
    // which user's keys this service was using (see keyDirFromUnit).
    const unitText = readFileSync(unitPath, "utf8");
    const keyDir = keyDirFromUnit(unitText);
    // Fall back to the current default only if the unit predates ExecStart
    // bookkeeping; never guess a path we then tell the user to delete.
    const binPath = execStartFromUnit(unitText) ?? `${LINUX_BIN_DIR}/pocketshell-agent`;
    await run(["systemctl", "disable", "--now", "pocketshell"]);
    rmSync(unitPath, { force: true });
    await run(["systemctl", "daemon-reload"]);
    console.log(`Stopped and removed the service: ${unitPath}`);
    // Remove our PATH symlink, but only if it still points at our binary —
    // never touch an unrelated file someone else put there.
    if (symlinkTargetOk(LINUX_SYMLINK, binPath)) {
      rmSync(LINUX_SYMLINK, { force: true });
      console.log(`Removed the command link: ${LINUX_SYMLINK}`);
    }
    printKeepNotice(binPath, keyDir);
    return 0;
  }
  if (platform === "darwin") {
    const home = process.env.HOME ?? "";
    const unitPath = `${home}/Library/LaunchAgents/com.pocketshell.agent.plist`;
    if (!existsSync(unitPath)) { console.log("No installed service found; nothing to uninstall."); return 0; }
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const keyDir = keyDirFromUnit(readFileSync(unitPath, "utf8"));
    await run(["launchctl", "bootout", `${launchdDomain(uid)}/com.pocketshell.agent`]);
    rmSync(unitPath, { force: true });
    console.log(`Stopped and removed the service: ${unitPath}`);
    printKeepNotice(`${home}/.local/bin/pocketshell-agent`, keyDir);
    return 0;
  }
  console.error(`Unsupported platform: ${platform}`);
  return 1;
}

function printKeepNotice(binPath: string, keyDir: string | null): void {
  console.log("");
  console.log("The following were kept (they hold your keys and paired devices — delete them and every phone must pair again):");
  if (keyDir) {
    console.log(`  key dir     ${keyDir}`);
  } else {
    // Never guess: an invented path is worse than admitting we don't know.
    console.log(`  key dir     not recorded in the service config; usually .pocketshell under the service user\x27s home`);
  }
  console.log(`  binary      ${binPath}`);
  console.log("");
  console.log("To wipe it completely, delete those paths by hand.");
}
