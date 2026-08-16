// req: `pocketshell-agent tunnel setup` —— 给没有域名的机器接上 Tailscale
// Funnel，拿到真 HTTPS 公网地址。
//
// 本文件只放**纯逻辑**：argv 解析、tailscale 输出解析、origin 推导、unit 的
// 解析与重渲染。所有副作用（spawn、读写文件、重启服务）在 tunnel-runner.ts。
// 沿用 cli-install.ts / install-runner.ts 已有的切分方式。
import {
  renderSystemdUnit, renderLaunchdPlist,
  SYSTEMD_UNIT_NAME, LAUNCHD_LABEL, LINUX_SYMLINK,
  type InstallPlan,
} from "./cli-install";

/** Funnel 只允许 443 / 8443 / 10000；固定 443，这样 advertise 不用带端口号。 */
export const FUNNEL_PORT = 443;

export type TunnelAction = { cmd: "setup" } | { cmd: "error"; message: string };

export const TUNNEL_USAGE = [
  "Usage:",
  "  sudo pocketshell-agent tunnel setup",
  "",
  "Gives this machine a real public HTTPS address through Tailscale Funnel, so",
  "your phone can reach it without you owning a domain or running a reverse proxy.",
  "",
  "It takes no options: the hostname is decided by your tailnet, not by you, and",
  "the public port is always 443.",
  "",
  "You will be asked to approve two things in a browser (logging this machine in,",
  "and enabling Funnel for your tailnet). Everything else is automatic.",
].join("\n");

export function parseTunnelArgv(argv: string[]): TunnelAction {
  const sub = argv[1];
  if (sub !== "setup") {
    if (sub === undefined) return { cmd: "error", message: TUNNEL_USAGE };
    return { cmd: "error", message: `Unknown subcommand: ${sub}\n\n${TUNNEL_USAGE}` };
  }
  const rest = argv.slice(2);
  if (rest.length > 0) {
    return { cmd: "error", message: `tunnel setup takes no arguments, got: ${rest[0]}\n\n${TUNNEL_USAGE}` };
  }
  return { cmd: "setup" };
}

/**
 * `tailscale status --json` 的 Self.DNSName，没有就返回 null。
 *
 * 这是「tailscale up 成功了吗」的唯一可信判据 —— 退出码不是（见 spec §5）。
 * 未登录时该字段是空串而不是缺失，"." 也当作空。
 */
export function dnsNameFromStatus(json: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  const self = (parsed as { Self?: unknown } | null)?.Self;
  if (!self || typeof self !== "object") return null;
  const name = (self as { DNSName?: unknown }).DNSName;
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/\.+$/, "");
  return trimmed.length > 0 ? name : null;
}

/** DNSName（可能带尾点）→ `wss://host`。空/纯点返回 null。 */
export function advertiseFromDnsName(dnsName: string): string | null {
  const host = dnsName.trim().replace(/\.+$/, "");
  return host.length > 0 ? `wss://${host}` : null;
}

/** 绕开本机 DNS 用的公共解析器。两个，第一个不通就换第二个。 */
export const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

/**
 * `dig +short` 的输出 → IPv4 列表。
 *
 * 为什么需要它：公网自检从 agent 本机发起，而那台机器**在 tailnet 里**，
 * MagicDNS 会把 `<host>.ts.net` 解析成它自己的 100.x 内网地址，而不是 Funnel
 * 的公网入口。连过去 TLS 当场被拒（2026-08-17 真机：0.077s 返回 000），于是
 * 一个明明配好的隧道被判成失败。
 *
 * 所以自检必须走公共 DNS 拿到边缘 IP，再用 curl --resolve 强制连它。
 * dig 也可能吐出 CNAME 行或告警，这里只挑纯 IPv4 行。
 */
export function ipsFromDigOutput(out: string): string[] {
  const v4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$/;
  return out.split("\n").map((l) => l.trim()).filter((l) => v4.test(l));
}

/** tailscale 分配的 100.64.0.0/10（CGNAT）地址——即 tailnet 内网，不是公网入口。 */
export function isTailscaleIp(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\./.exec(ip.trim());
  if (!m) return false;
  const a = Number(m[1]!), b = Number(m[2]!);
  return a === 100 && b >= 64 && b <= 127;
}

export type FunnelState =
  | "none"        // 完全没有 serve 配置
  | "elsewhere"   // 有配置，但没指向我们的端口
  | "ours";       // 已指向我们的端口

/**
 * `tailscale funnel status` 是**文本**输出（不像 status 有 --json），所以这里
 * 只做一件事：找有没有一行提到我们的 origin。
 *
 * 端口用带边界的正则匹配，而不是 includes —— 否则端口 8722 会匹配到 18722 上。
 * 判不出来时返回 "elsewhere"（保守），调用方会连原始输出一起打印给用户，
 * 绝不静默继续（spec §8）。
 */
export function funnelState(statusOut: string, origin: string): FunnelState {
  const text = statusOut.trim();
  if (text.length === 0 || /No serve config/i.test(text)) return "none";
  // 匹配整个 origin（含 host），不是只匹配端口：用户可能用 --host 绑在
  // 192.168.1.5 上，只认 127.0.0.1 会让「明明配对了」被判成 elsewhere，
  // 于是 setup 反复轮询后报失败——配置其实是好的。
  // 尾部的 (?![0-9]) 防子串误伤：端口 8722 不能匹配到 18722 上。
  const re = new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`);
  return re.test(text) ? "ours" : "elsewhere";
}

export type OriginResult =
  | { ok: true; url: string; port: number }
  | { ok: false; message: string };

/**
 * 从 unit 的 Environment 推导 Funnel 该指向哪个本机地址。
 *
 * **不要写死 8722**：v1 就是这么干的，用户若 `install --port 9000`，隧道会指向
 * 一个无人监听的端口，而且全程没有任何报错。
 */
export function originFromEnv(env: Record<string, string>): OriginResult {
  if (env.POCKETSHELL_TLS === "1") {
    return {
      ok: false,
      message:
        "This agent is configured with POCKETSHELL_TLS=1, which `tunnel setup` does not support yet.\n" +
        "Funnel terminates TLS for you, so the agent behind it should speak plain HTTP on loopback.\n" +
        "Either turn TLS off in the service config, or keep your current reverse proxy setup (see DEPLOYMENT.md).",
    };
  }
  const rawPort = env.POCKETSHELL_PORT ?? "8722";
  const port = Number(rawPort);
  if (!/^[0-9]+$/.test(rawPort.trim()) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: `The service config has an unusable POCKETSHELL_PORT: ${rawPort}` };
  }
  const host = env.POCKETSHELL_HOST ?? "127.0.0.1";
  // 0.0.0.0 / :: 是绑定通配符，不是可连接地址（同 install-runner.ts:137 的 waitReady）。
  const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return { ok: true, url: `http://${target}:${port}`, port };
}

/** 按平台分派到既有渲染器。install-runner 的 writeUnit 也用它。 */
export function renderUnitFor(plan: InstallPlan): string {
  return plan.platform === "linux" ? renderSystemdUnit(plan) : renderLaunchdPlist(plan);
}

function xmlUnescape(s: string): string {
  // 顺序要紧：&amp; 必须最后还原，否则 "&amp;lt;" 会被两步还原成 "<"。
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function planFromSystemdUnit(text: string, unitPath: string): InstallPlan | null {
  const user = /^User=(.*)$/m.exec(text)?.[1]?.trim();
  const home = /^WorkingDirectory=(.*)$/m.exec(text)?.[1]?.trim();
  const binPath = /^ExecStart=(.*)$/m.exec(text)?.[1]?.trim();
  if (!user || !home || !binPath) return null;

  const env: Record<string, string> = {};
  for (const m of text.matchAll(/^Environment=([A-Za-z0-9_]+)=(.*)$/gm)) env[m[1]!] = m[2]!;

  return {
    platform: "linux",
    user,
    home,
    keyDir: env.POCKETSHELL_KEY_DIR ?? `${home}/.pocketshell`,
    binPath,
    binOwner: user,
    symlinkPath: LINUX_SYMLINK,
    unitPath,
    label: SYSTEMD_UNIT_NAME,
    env,
  };
}

function planFromLaunchdPlist(text: string, unitPath: string): InstallPlan | null {
  const pick = (key: string): string | undefined => {
    const m = new RegExp(`<key>${key}</key><string>([^<]*)</string>`).exec(text);
    return m ? xmlUnescape(m[1]!) : undefined;
  };
  const label = pick("Label");
  const home = pick("WorkingDirectory");
  const binPath = xmlUnescape(/<array><string>([^<]*)<\/string><\/array>/.exec(text)?.[1] ?? "");
  if (!label || !home || !binPath) return null;

  // EnvironmentVariables 里的条目缩进四格，顶层的缩进两格 —— 见
  // renderLaunchdPlist 的 envLines。靠缩进区分，避免把 Label 当环境变量读进来。
  const env: Record<string, string> = {};
  for (const m of text.matchAll(/^ {4}<key>([A-Za-z0-9_]+)<\/key><string>([^<]*)<\/string>$/gm)) {
    env[m[1]!] = xmlUnescape(m[2]!);
  }
  // PATH 是渲染器从 tmuxDir 合成的，不是真正的服务环境变量；抽出来别放回 env，
  // 否则重渲染会多出一条 PATH 行。
  const path = env.PATH;
  delete env.PATH;

  return {
    platform: "darwin",
    // plist 里没有 User 字段（LaunchAgent 天然跑在调用者的用户域下）。这里从
    // home 兜一个值纯粹是为了满足类型；renderLaunchdPlist 一个字都不读它。
    user: home.split("/").filter(Boolean).pop() ?? "",
    home,
    keyDir: env.POCKETSHELL_KEY_DIR ?? `${home}/.pocketshell`,
    binPath,
    unitPath,
    label,
    logPath: pick("StandardOutPath"),
    tmuxDir: path ? path.split(":")[0] : undefined,
    env,
  };
}

/**
 * 把一份已装好的 unit 反解回 InstallPlan，好让我们用**既有渲染器**改写它，
 * 而不是做文本替换。反解不出来就返回 null，调用方给手工指引。
 */
export function planFromUnit(
  text: string, unitPath: string, platform: "linux" | "darwin",
): InstallPlan | null {
  return platform === "linux"
    ? planFromSystemdUnit(text, unitPath)
    : planFromLaunchdPlist(text, unitPath);
}

/** 只换 advertise，其余原样。返回新对象，不改入参。 */
export function planWithAdvertise(plan: InstallPlan, advertise: string): InstallPlan {
  return { ...plan, env: { ...plan.env, POCKETSHELL_ADVERTISE: advertise } };
}

/**
 * 「解析 → 重渲染」能否逐字节复现原文。
 *
 * 这是改写 unit 的**准入条件**：能复现，说明这份文件确实是我们写的、我们的
 * 模型完整覆盖了它的内容，改一个值不会顺手抹掉别的东西；复现不了，说明有人
 * 手工加过行（KillMode=、After=、ExecStartPre= 之类），此时宁可拒绝改写。
 * 精神同 persistAgentJson 的 `never clobber user edits`。
 */
export function canSafelyRewrite(text: string, plan: InstallPlan): boolean {
  return renderUnitFor(plan) === text;
}
