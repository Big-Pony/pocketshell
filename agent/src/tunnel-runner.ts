// req: `pocketshell-agent tunnel setup` 的副作用半边。纯决策都在 cli-tunnel.ts
// 与 dep-install.ts，本文件只负责跑命令、探状态、改配置。
//
// 本文件的四条硬规（每一条都有真机血案，见 spec §6）：
//   1. 子进程一律 argv 数组，永不拼 shell 串 —— sudo -S + 管道会静默吞输入且
//      退出码为 0（2026-07-30 装服务、2026-08-16 装隧道各栽一次）；
//   2. 授权 URL 必须实时透传（runInteractive），不能缓冲到进程结束 —— 那是一个
//      正在阻塞等人点链接的进程；
//   3. 成功判据是**探测目标状态**，不是退出码 —— tailscale funnel 在权限不足、
//      tailnet 未启用 Funnel 时全都返回 EXIT=0；
//   4. 改写 unit 前先备份，且必须能逐字节复现原文才准动（canSafelyRewrite）。
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dnsNameFromStatus, advertiseFromDnsName, funnelState,
  originFromEnv, planFromUnit, FUNNEL_PORT,
} from "./cli-tunnel";
import { decideTailscaleInstall } from "./dep-install";
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME } from "./cli-install";

export interface TunnelDeps {
  platform: string;
  euid: number;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  /** 跑命令并捕获输出（用于探测）。 */
  run: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** 跑命令并把输出**实时**透传到终端（用于人工授权步骤）。 */
  runInteractive: (argv: string[]) => Promise<{ code: number }>;
  readFile: (path: string) => string | null;
  writeFile: (path: string, text: string) => void;
  copyFile: (from: string, to: string) => void;
  /** GET 一个公网 URL，返回状态码；连不上返回 null。 */
  fetchStatus: (url: string) => Promise<number | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  error: (line: string) => void;
}

export function unitPathFor(platform: string, home: string): string | null {
  if (platform === "linux") return `/etc/systemd/system/${SYSTEMD_UNIT_NAME}.service`;
  if (platform === "darwin") return `${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
  return null;
}

/** 反复探测直到 read() 返回非 null，或次数用尽。 */
async function poll<T>(
  deps: TunnelDeps, tries: number, everyMs: number, read: () => Promise<T | null>,
): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const v = await read();
    if (v !== null) return v;
    if (i < tries - 1) await deps.sleep(everyMs);
  }
  return null;
}

export async function runTunnelSetup(deps: TunnelDeps): Promise<number> {
  // ---- 第一段：本地探测。这一段结束前不碰系统任何东西 ----
  const home = deps.env.HOME ?? "";
  const unitPath = unitPathFor(deps.platform, home);
  if (!unitPath) {
    deps.error(`Unsupported platform: ${deps.platform}. tunnel setup supports Linux (systemd) and macOS (launchd) only.`);
    return 1;
  }
  if (deps.platform === "linux" && deps.euid !== 0) {
    deps.error("tunnel setup needs root (it installs Tailscale and rewrites the service config).\nRun it as: sudo pocketshell-agent tunnel setup");
    return 1;
  }

  const unitText = deps.readFile(unitPath);
  if (unitText === null) {
    deps.error([
      "PocketShell is not installed as a service yet, so there is nothing to point a tunnel at.",
      "Install it first, then come back:",
      deps.platform === "linux"
        ? "    sudo pocketshell-agent install --advertise ws://127.0.0.1:8722"
        : "    pocketshell-agent install --advertise ws://127.0.0.1:8722",
      "",
      "(That placeholder address is fine — `tunnel setup` replaces it with your public one.)",
    ].join("\n"));
    return 1;
  }

  const plan = planFromUnit(unitText, unitPath, deps.platform === "linux" ? "linux" : "darwin");
  if (!plan) {
    deps.error(`Could not read the service config at ${unitPath} — it does not look like one PocketShell wrote.\nFix or reinstall the service, then re-run.`);
    return 1;
  }

  const origin = originFromEnv(plan.env);
  if (!origin.ok) { deps.error(origin.message); return 1; }

  if ((await deps.run(["tmux", "-V"])).code !== 0) {
    deps.error("tmux is missing — PocketShell needs it for session persistence, and the service will not start without it.\nRun `pocketshell-agent install` again, which sets it up, then re-run tunnel setup.");
    return 1;
  }

  const present = (await deps.run(["tailscale", "version"])).code === 0;
  const decision = decideTailscaleInstall({
    present, platform: deps.platform, isTTY: deps.isTTY, euid: deps.euid,
    scriptPath: join(tmpdir(), "pocketshell-tailscale-install.sh"),
  });
  if (decision.action === "manual") { deps.error(decision.message); return 1; }
  if (decision.action === "install") {
    deps.log("Installing Tailscale (this is the official installer from tailscale.com)…");
    for (const argv of decision.argv) {
      const r = await deps.run(argv);
      if (r.code !== 0) {
        deps.error(`Installing Tailscale failed:\n${r.stderr || r.stdout}`);
        return 1;
      }
    }
    if ((await deps.run(["tailscale", "version"])).code !== 0) {
      // 又一次「不看退出码」：安装脚本可能成功退出却没留下可用的命令。
      deps.error("The Tailscale installer finished, but the `tailscale` command is still not available. Install it by hand and re-run.");
      return 1;
    }
    deps.log("Tailscale installed.");
  }

  // ---- 第二段：人工授权（两处，都在流程中段，代管不了）----
  const readDnsName = async (): Promise<string | null> =>
    dnsNameFromStatus((await deps.run(["tailscale", "status", "--json"])).stdout);

  let dnsName = await readDnsName();
  if (dnsName === null) {
    deps.log("");
    deps.log("Tailscale needs to be signed in. A login URL will appear below — open it in any browser and approve this machine.");
    deps.log("");
    await deps.runInteractive(["tailscale", "up"]);
    dnsName = await poll(deps, 10, 1000, readDnsName);
  }
  if (dnsName === null) {
    deps.error("This machine still is not signed in to a tailnet, so it has no public hostname yet.\nRun `tailscale up` by hand, finish the browser step, then re-run: sudo pocketshell-agent tunnel setup");
    return 1;
  }

  const advertise = advertiseFromDnsName(dnsName);
  if (!advertise) {
    deps.error(`Tailscale reported an unusable hostname: ${JSON.stringify(dnsName)}`);
    return 1;
  }
  const publicHost = advertise.replace(/^wss:\/\//, "");
  deps.log(`This machine's public hostname: ${publicHost}`);

  // ---- 第三段：变更 ----
  const readFunnel = async () => (await deps.run(["tailscale", "funnel", "status"])).stdout;
  let funnelOut = await readFunnel();
  if (funnelState(funnelOut, origin.url) !== "ours") {
    deps.log("");
    deps.log("Turning on Funnel. The first time, your tailnet has to allow it — if a URL appears below, open it and approve, then this will continue.");
    deps.log("");
    await deps.runInteractive([
      "tailscale", "funnel", "--bg", "--yes", `--https=${FUNNEL_PORT}`, origin.url,
    ]);
    const ok = await poll(deps, 10, 1000, async () => {
      funnelOut = await readFunnel();
      return funnelState(funnelOut, origin.url) === "ours" ? true : null;
    });
    if (!ok) {
      // 退出码在这里毫无价值：权限不足与能力未启用都返回 0。把原始输出交出去。
      deps.error("Funnel is still not forwarding to this agent. Tailscale reported:");
      deps.error(funnelOut.trim() || "(no output)");
      deps.error("");
      deps.error("Most often this means your tailnet has not enabled Funnel yet. Enable it in the Tailscale admin console (Access Controls), then re-run: sudo pocketshell-agent tunnel setup");
      return 1;
    }
    deps.log("Funnel is on.");
  } else {
    deps.log("Funnel already forwards to this agent.");
  }

  // 公网自检：这是唯一能证明「用户的手机真能连上」的判据。首次证书签发实测
  // 60s+，所以给两分钟而不是几秒。
  deps.log("Checking the public address from the outside (the first HTTPS certificate can take a minute)…");
  const reachable = await poll(deps, 24, 5000, async () => {
    const code = await deps.fetchStatus(`https://${publicHost}/`);
    return code !== null && code < 500 ? code : null;
  });
  if (reachable === null) {
    deps.error(`Funnel is configured, but https://${publicHost}/ did not answer within two minutes.`);
    deps.error("Nothing was changed in the service config. Check `tailscale funnel status` and try again later — certificate issuance is rate-limited and can need a long wait after repeated failures.");
    return 1;
  }
  deps.log(`✓ https://${publicHost}/ answered (HTTP ${reachable}).`);

  // advertise 回填在 Task 6 接上；在那之前先把地址告诉用户。
  deps.log("");
  deps.log(`Your public address: https://${publicHost}`);
  return 0;
}

export function realTunnelDeps(): TunnelDeps {
  return {
    platform: process.platform,
    euid: typeof process.geteuid === "function" ? process.geteuid() : 0,
    isTTY: Boolean(process.stdin.isTTY),
    env: process.env,
    async run(argv) {
      const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code: await proc.exited, stdout, stderr };
    },
    async runInteractive(argv) {
      // "inherit" 是这里的全部要点：授权 URL 必须边打印边出现。改成 "pipe"
      // 再事后打印，用户看到的就是一个「挂死」的命令（2026-08-16 实测三次）。
      const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return { code: await proc.exited };
    },
    readFile: (p) => { try { return existsSync(p) ? readFileSync(p, "utf8") : null; } catch { return null; } },
    writeFile: (p, text) => writeFileSync(p, text, { mode: 0o644 }),
    copyFile: (from, to) => copyFileSync(from, to),
    async fetchStatus(url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
        return res.status;
      } catch { return null; }
    },
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  };
}
