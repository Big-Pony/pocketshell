// req: side-effecting half of the install/uninstall subcommands. Every pure
// decision lives in cli-install.ts; this file only touches the filesystem and
// spawns the supervisor CLIs.
//
// House rule for this file: never build a shell command string. Always pass an
// argv array to Bun.spawn. A `sudo -S` + pipe combination silently swallowed a
// heredoc during the 2026-07-30 manual install and still exited 0 — argv arrays
// make that class of failure impossible.
import { existsSync, copyFileSync, writeFileSync, mkdirSync, realpathSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  parseInstallArgv, resolvePlan, renderSystemdUnit, renderLaunchdPlist,
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

/** Copies the running binary into place, skipping a no-op self-copy. */
function installBinary(plan: InstallPlan): string {
  const src = realpathSync(process.execPath);
  const alreadyThere = existsSync(plan.binPath) && realpathSync(plan.binPath) === src;
  if (alreadyThere) {
    // Copying a file onto itself truncates the running binary to 0 bytes.
    return `二进制已在目标位置，跳过复制：${plan.binPath}`;
  }
  mkdirSync(dirname(plan.binPath), { recursive: true });
  copyFileSync(src, plan.binPath);
  chmodSync(plan.binPath, 0o755);
  return `已安装二进制：${plan.binPath}`;
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

function printSuccess(plan: InstallPlan, pairing: string | null): void {
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
  console.log(installBinary(plan));
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
  printSuccess(plan, extractPairingString(await readServiceLog(plan)));
  return 0;
}

async function bootstrapLaunchd(_plan: InstallPlan): Promise<number> {
  console.error("macOS 支持在 Task 7 实现");
  return 1;
}

export async function runUninstall(): Promise<number> {
  console.error("uninstall 在 Task 7 实现");
  return 1;
}
