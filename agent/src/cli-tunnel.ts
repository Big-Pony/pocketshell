// req: `pocketshell-agent tunnel setup` —— 给没有域名的机器接上 Tailscale
// Funnel，拿到真 HTTPS 公网地址。
//
// 本文件只放**纯逻辑**：argv 解析、tailscale 输出解析、origin 推导、unit 的
// 解析与重渲染。所有副作用（spawn、读写文件、重启服务）在 tunnel-runner.ts。
// 沿用 cli-install.ts / install-runner.ts 已有的切分方式。

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
export function funnelState(statusOut: string, port: number): FunnelState {
  const text = statusOut.trim();
  if (text.length === 0 || /No serve config/i.test(text)) return "none";
  const re = new RegExp(`127\\.0\\.0\\.1:${port}(?![0-9])`);
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
