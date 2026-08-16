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
  originFromEnv, planFromUnit, planWithAdvertise, canSafelyRewrite, renderUnitFor,
  ipsFromDigOutput, isTailscaleIp, PUBLIC_RESOLVERS,
  FUNNEL_PORT,
} from "./cli-tunnel";
import { decideTailscaleInstall } from "./dep-install";
import { backupPath, extractPairingString, pairedDeviceCount } from "./install-runner";
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, type InstallPlan } from "./cli-install";

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
  /**
   * GET 一个公网 URL，返回状态码；连不上返回 null。
   *
   * `forceIp` 非空时必须**绕开本机 DNS**、直连该 IP，同时保持 Host 与 SNI 仍是
   * 原域名（Funnel 边缘靠 SNI 认人，改了就认不出是谁）。见 checkPublic 的注释。
   */
  fetchStatus: (url: string, forceIp?: string) => Promise<number | null>;
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

/**
 * 公网自检：确认外面的人（你的手机）真能连上这个地址。
 *
 * **为什么不能直接 fetch 这个 hostname**（2026-08-17 真机踩坑，一度把一条配好
 * 的隧道判成失败）：自检从 agent 本机发起，而那台机器**在 tailnet 里**。
 * MagicDNS 会把 `<host>.ts.net` 解析成它自己的 100.x 内网地址，而不是 Funnel
 * 的公网入口；连过去 TLS 当场被拒，0.077 秒返回 000 —— 看起来像「公网不通」，
 * 其实是「本机看不见公网入口」。同一时刻从 tailnet 外面 curl 是 200。
 *
 * 所以：先用公共 DNS 解析出真实边缘 IP，再强制连它（Host 与 SNI 保持原域名，
 * Funnel 边缘靠 SNI 认人）。真机验证：dig @1.1.1.1 得 208.111.34.11 /
 * 208.111.35.209，--resolve 过去同一台机器立刻 200。
 *
 * 解析不出边缘 IP 时**回落为直连**（不带 forceIp）：不在 tailnet 里的机器本来
 * 就该走这条路，而这也让「dig 缺失」不至于直接判失败。
 */
async function checkPublic(deps: TunnelDeps, publicHost: string): Promise<number | null> {
  const edgeIps: string[] = [];
  for (const resolver of PUBLIC_RESOLVERS) {
    const r = await deps.run(["dig", "+short", "+time=3", "+tries=1", publicHost, `@${resolver}`]);
    // 退出码同样不作数：dig 拿不到答案时也可能是 0。看解析结果本身。
    const ips = ipsFromDigOutput(r.stdout).filter((ip) => !isTailscaleIp(ip));
    if (ips.length > 0) { edgeIps.push(...ips); break; }
  }
  if (edgeIps.length === 0) {
    // 没绕成就直连。可能是没装 dig、公共 DNS 被墙，也可能这台机器本来就不在
    // tailnet 里（那样直连就是对的）。
    return poll(deps, 24, 5000, async () => {
      const code = await deps.fetchStatus(`https://${publicHost}/`);
      return code !== null && code < 500 ? code : null;
    });
  }
  return poll(deps, 24, 5000, async () => {
    for (const ip of edgeIps) {
      const code = await deps.fetchStatus(`https://${publicHost}/`, ip);
      if (code !== null && code < 500) return code;
    }
    return null;
  });
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
  const reachable = await checkPublic(deps, publicHost);
  if (reachable === null) {
    deps.error(`Funnel is configured, but https://${publicHost}/ did not answer within two minutes.`);
    deps.error("Nothing was changed in the service config. Check `tailscale funnel status` and try again later — certificate issuance is rate-limited and can need a long wait after repeated failures.");
    return 1;
  }
  deps.log(`✓ https://${publicHost}/ answered (HTTP ${reachable}).`);

  const code = await backfillAdvertise(deps, plan, unitText, advertise);
  if (code !== 0) return code;

  // 重启会重新铸一个开机配对码（仅当还没有已配对设备时，见 config.ts 的
  // pairingMode）。把它读出来直接交给用户，省掉一次「再跑一条命令」。
  const log = plan.platform === "linux"
    ? (await deps.run(["journalctl", "-u", plan.label, "--since", "-2 min", "-o", "cat", "--no-pager"])).stdout
    : (deps.readFile(plan.logPath ?? "") ?? "");
  const pairing = extractPairingString(log);

  deps.log("");
  deps.log(`✓ Done. Open this on your phone:  https://${publicHost}`);
  deps.log("");
  if (pairing) {
    deps.log("Paste this pairing string into the app (valid for 300s):");
    deps.log("");
    deps.log(`  ${pairing}`);
  } else if (pairedDeviceCount(plan.keyDir) > 0) {
    deps.log("Your already-paired devices keep working. To add another phone, run:");
    deps.log(`  ${plan.binPath} pair`);
  } else {
    deps.log("To get a pairing string, run:");
    deps.log(`  ${plan.binPath} pair`);
  }
  deps.log("");
  deps.log("Add it to your home screen there and you get push notifications too — that needs the HTTPS address you now have.");
  return 0;
}

function stampNow(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把公网地址写回服务配置。
 *
 * **为什么改 unit 而不是 agent.json**：config.ts:155 是
 * `env.POCKETSHELL_ADVERTISE ?? file.advertise` —— env 赢。而 --advertise 是
 * install 的必填项，所以每台装过的机器 unit 里都有那行 Environment=，写
 * agent.json 永远被它盖掉（config.test.ts 有一条测试钉死这个优先级）。第二道
 * 障碍是 persistAgentJson 的 `never clobber user edits`：agent.json 此刻必然
 * 已存在，走那条路写也写不进去。
 *
 * 改 env 本身不引入任何反常优先级 —— 我们改的正是那个最高优先级的来源。
 */
export async function backfillAdvertise(
  deps: TunnelDeps, plan: InstallPlan, unitText: string, advertise: string,
): Promise<number> {
  const manualHint = [
    `Set this in ${plan.unitPath} by hand:`,
    `    POCKETSHELL_ADVERTISE=${advertise}`,
    plan.platform === "linux"
      ? "then: sudo systemctl daemon-reload && sudo systemctl restart pocketshell"
      : `then: launchctl bootout gui/$(id -u)/${plan.label}; launchctl bootstrap gui/$(id -u) ${plan.unitPath}`,
  ].join("\n");

  if (!canSafelyRewrite(unitText, plan)) {
    deps.error(`The service config at ${plan.unitPath} has been edited by hand, so it will not be rewritten automatically (that would drop your changes).`);
    deps.error(manualHint);
    return 1;
  }

  const bak = backupPath(plan.unitPath, stampNow(deps.now()));
  deps.copyFile(plan.unitPath, bak);
  deps.writeFile(plan.unitPath, renderUnitFor(planWithAdvertise(plan, advertise)));
  deps.log(`Updated the service config (previous one kept at ${bak}).`);

  if (plan.platform === "linux") {
    const reload = await deps.run(["systemctl", "daemon-reload"]);
    if (reload.code !== 0) { deps.error(`systemctl daemon-reload failed:\n${reload.stderr}`); deps.error(manualHint); return 1; }
    const restart = await deps.run(["systemctl", "restart", plan.label]);
    if (restart.code !== 0) { deps.error(`Could not restart the service:\n${restart.stderr}`); deps.error(manualHint); return 1; }
  } else {
    const uid = deps.euid;
    await deps.run(["launchctl", "bootout", `gui/${uid}/${plan.label}`]);
    const boot = await deps.run(["launchctl", "bootstrap", `gui/${uid}`, plan.unitPath]);
    if (boot.code !== 0) { deps.error(`Could not restart the service:\n${boot.stderr}`); deps.error(manualHint); return 1; }
  }
  deps.log("Service restarted on the new address.");
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
    async fetchStatus(url, forceIp) {
      if (!forceIp) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
          return res.status;
        } catch { return null; }
      }
      // fetch 没有「域名不变、强制走某个 IP」的开关，而这正是绕开 MagicDNS 所
      // 需要的（Host 与 SNI 必须仍是原域名，Funnel 边缘靠 SNI 认人）。curl 的
      // --resolve 正好是这个语义。仍然是 argv 数组，没有 shell。
      const host = new URL(url).hostname;
      const proc = Bun.spawn(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10",
         "--resolve", `${host}:443:${forceIp}`, url],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const code = Number(out.trim());
      // curl 连不上时打印 000 —— 那不是一个 HTTP 状态码，别当成功。
      return Number.isInteger(code) && code >= 100 ? code : null;
    },
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  };
}
