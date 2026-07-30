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
  parseInstallArgv, resolvePlan, renderSystemdUnit, renderLaunchdPlist,
  LINUX_BIN_DIR, LINUX_SYMLINK,
  type InstallPlan,
} from "./cli-install";
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
    lines.push(`二进制已在目标位置，跳过复制：${plan.binPath}`);
  } else {
    replaceBinary(src, plan.binPath);
    lines.push(`已安装二进制：${plan.binPath}`);
  }
  // Hand the binary's directory to the service user: OTA writes a temp file
  // beside the binary and renames over it, which needs directory write access
  // (v1.6.0 shipped it root-owned and OTA died with EACCES).
  if (plan.binOwner) {
    const dir = dirname(plan.binPath);
    const r = Bun.spawnSync(["chown", "-R", `${plan.binOwner}:`, dir]);
    if (r.exitCode === 0) lines.push(`已把 ${dir} 交给 ${plan.binOwner}（应用内更新需要写这个目录）`);
    else lines.push(`警告：chown ${dir} 失败，应用内更新可能因权限不足而失败`);
  }
  // Keep the command on the global PATH — `sudo pocketshell-agent uninstall`
  // resolves through root's PATH, which does not include the install dir.
  if (plan.symlinkPath && !symlinkTargetOk(plan.symlinkPath, plan.binPath)) {
    mkdirSync(dirname(plan.symlinkPath), { recursive: true });
    rmSync(plan.symlinkPath, { force: true }); // may be a stale real binary
    symlinkSync(plan.binPath, plan.symlinkPath);
    lines.push(`已建立命令链接：${plan.symlinkPath} → ${plan.binPath}`);
  }
  return lines;
}

/** Writes the unit, backing up any existing one first. Returns log lines. */
function writeUnit(plan: InstallPlan): string[] {
  const lines: string[] = [];
  const text = plan.platform === "linux" ? renderSystemdUnit(plan) : renderLaunchdPlist(plan);
  if (existsSync(plan.unitPath)) {
    const bak = backupPath(plan.unitPath, stampNow());
    copyFileSync(plan.unitPath, bak);
    lines.push(`已备份原有服务配置：${bak}`);
  }
  mkdirSync(dirname(plan.unitPath), { recursive: true });
  writeFileSync(plan.unitPath, text, { mode: 0o644 });
  lines.push(`已写入服务配置：${plan.unitPath}`);
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
  console.log(`✓ PocketShell 已装成系统服务，开机自动启动。`);
  console.log("");
  console.log(`  服务用户    ${plan.user}`);
  console.log(`  密钥目录    ${plan.keyDir}`);
  console.log(`  访问地址    ${appUrl}`);
  console.log("");
  if (pairing) {
    console.log(`手机打开上面的地址，粘贴这个配对串（有效期 300 秒）：`);
    console.log("");
    console.log(`  ${pairing}`);
  } else if (paired > 0) {
    // Not a failure: the agent deliberately skips minting a boot code when the
    // registry is non-empty, so no string exists to print. Pointing at the log
    // here would send the operator hunting for something never written.
    console.log(`这台机器上已有 ${paired} 台配对过的设备，可以直接用，无需重新配对。`);
    console.log(`要加一台新手机，运行：`);
    console.log(`  ${plan.binPath} pair`);
  } else {
    console.log(`服务已启动，但没能自动取到配对串。手动查看：`);
    console.log(plan.platform === "linux"
      ? `  journalctl -u ${plan.label} -n 30`
      : `  tail -n 30 ${plan.logPath}`);
  }
  console.log("");
  console.log(`如果还没配反向代理（让手机能从外网访问），见部署指南「方式 B」：`);
  console.log(`  https://github.com/Big-Pony/pocketshell/blob/main/DEPLOYMENT-CN.md`);
  console.log("");
  console.log(`卸载：pocketshell-agent uninstall`);
}

export async function runInstall(argv: string[]): Promise<number> {
  const action = parseInstallArgv(argv);
  if (action.cmd === "error") { console.error(action.message); return 1; }
  if (action.cmd !== "install") { console.error("内部错误：runInstall 收到非 install 动作"); return 1; }

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
    console.log("提示：服务将以 root 身份运行，手机连上后拿到的是 root shell。");
    console.log("      想用普通用户，加 --user <用户名> 重新运行。");
  }

  // --- mutating phase ---
  for (const l of installBinary(plan)) console.log(l);
  for (const l of writeUnit(plan)) console.log(l);

  if (plan.platform === "linux") {
    const reload = await run(["systemctl", "daemon-reload"]);
    if (reload.code !== 0) { console.error(`systemctl daemon-reload 失败：\n${reload.stderr}`); return 1; }
    const up = await run(["systemctl", "enable", "--now", plan.label]);
    if (up.code !== 0) {
      console.error(`启动服务失败：\n${up.stderr}`);
      const st = await run(["systemctl", "status", plan.label, "--no-pager", "-l"]);
      console.error(st.stdout.split("\n").slice(-20).join("\n"));
      return 1;
    }
    console.log(`已启用并启动服务：${plan.label}.service`);
  } else {
    return await bootstrapLaunchd(plan);
  }

  const ready = await waitReady(plan.env.POCKETSHELL_HOST, Number(plan.env.POCKETSHELL_PORT));
  if (!ready) {
    console.error(`服务已注册，但 15 秒内没能在 ${plan.env.POCKETSHELL_HOST}:${plan.env.POCKETSHELL_PORT} 上响应。`);
    console.error(`查看日志：journalctl -u ${plan.label} -n 30`);
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
// 2026-07-30 acceptance run printed "密钥目录 /root/.pocketshell" for a service
// whose keys actually lived in /home/myt/.pocketshell — a path that did not
// even exist. Returns null when the unit predates this field, so the caller can
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
    console.error(`launchctl bootstrap 失败：\n${boot.stderr || boot.stdout}`);
    return 1;
  }
  console.log(`已注册并启动服务：${plan.label}`);

  const ready = await waitReady(plan.env.POCKETSHELL_HOST, Number(plan.env.POCKETSHELL_PORT));
  if (!ready) {
    console.error(`服务已注册，但 15 秒内没能在 ${plan.env.POCKETSHELL_HOST}:${plan.env.POCKETSHELL_PORT} 上响应。`);
    console.error(`查看日志：tail -n 30 ${plan.logPath}`);
    return 1;
  }
  printSuccess(plan, extractPairingString(await readServiceLog(plan)), pairedDeviceCount(plan.keyDir));
  return 0;
}

export async function runUninstall(): Promise<number> {
  const platform = process.platform;
  if (platform === "linux") {
    if (typeof process.geteuid === "function" && process.geteuid() !== 0) {
      console.error("uninstall 需要 root 权限。请改用：sudo pocketshell-agent uninstall");
      return 1;
    }
    const unitPath = "/etc/systemd/system/pocketshell.service";
    if (!existsSync(unitPath)) { console.log("没有找到已安装的服务，无需卸载。"); return 0; }
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
    console.log(`已停止并移除服务：${unitPath}`);
    // Remove our PATH symlink, but only if it still points at our binary —
    // never touch an unrelated file someone else put there.
    if (symlinkTargetOk(LINUX_SYMLINK, binPath)) {
      rmSync(LINUX_SYMLINK, { force: true });
      console.log(`已移除命令链接：${LINUX_SYMLINK}`);
    }
    printKeepNotice(binPath, keyDir);
    return 0;
  }
  if (platform === "darwin") {
    const home = process.env.HOME ?? "";
    const unitPath = `${home}/Library/LaunchAgents/com.pocketshell.agent.plist`;
    if (!existsSync(unitPath)) { console.log("没有找到已安装的服务，无需卸载。"); return 0; }
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const keyDir = keyDirFromUnit(readFileSync(unitPath, "utf8"));
    await run(["launchctl", "bootout", `${launchdDomain(uid)}/com.pocketshell.agent`]);
    rmSync(unitPath, { force: true });
    console.log(`已停止并移除服务：${unitPath}`);
    printKeepNotice(`${home}/.local/bin/pocketshell-agent`, keyDir);
    return 0;
  }
  console.error(`不支持的平台：${platform}`);
  return 1;
}

function printKeepNotice(binPath: string, keyDir: string | null): void {
  console.log("");
  console.log("以下内容已保留（里面有密钥与已配对设备，删掉所有手机都要重新配对）：");
  if (keyDir) {
    console.log(`  密钥目录  ${keyDir}`);
  } else {
    // Never guess: an invented path is worse than admitting we don't know.
    console.log(`  密钥目录  服务配置里没有记录，通常是服务运行用户 home 下的 .pocketshell`);
  }
  console.log(`  二进制    ${binPath}`);
  console.log("");
  console.log("确实要彻底清除，手动删除上面两个路径即可。");
}
