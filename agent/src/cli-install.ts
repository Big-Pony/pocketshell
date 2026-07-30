// req: one-command service install. Pure helpers only — argv parsing, platform
// resolution and unit-file rendering live here so they are unit-tested; every
// side effect (copying the binary, writing units, spawning systemctl) stays in
// install-runner.ts. Mirrors the split already used by cli-devices.ts.

export interface InstallOpts {
  advertise: string;
  name?: string;
  user?: string;
  host: string;
  port: number;
}

export type InstallAction =
  | { cmd: "install"; opts: InstallOpts }
  | { cmd: "uninstall" }
  | { cmd: "error"; message: string };

export const INSTALL_USAGE = [
  "用法：",
  "  pocketshell-agent install --advertise <地址> [--name <实例名>] [--user <用户>] [--host <绑定地址>] [--port <端口>]",
  "  pocketshell-agent uninstall",
  "",
  "  --advertise  必填。写进配对串的对外地址，手机据此连接。ws:// 或 wss:// 开头。",
  "  --name       实例名，装多台时用来区分（显示在 PWA 图标与 App 顶栏）。",
  "  --user       服务运行用户。Linux 默认取 sudo 的发起者，macOS 取当前用户。",
  "  --host       绑定地址，默认 127.0.0.1（配反代时用它；手机直连局域网填 0.0.0.0）。",
  "  --port       端口，默认 8722。",
].join("\n");

/** Rejects values that could break out of a unit file line or corrupt a plist. */
export function validateEnvValue(v: string): boolean {
  return !/[\x00-\x1f\x7f]/.test(v);
}

const NEEDS_VALUE = new Set(["--advertise", "--name", "--user", "--host", "--port"]);

export function parseInstallArgv(argv: string[]): InstallAction {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === "uninstall") {
    if (rest.length > 0) return { cmd: "error", message: `uninstall 不接受参数：${rest[0]}\n\n${INSTALL_USAGE}` };
    return { cmd: "uninstall" };
  }
  if (sub !== "install") return { cmd: "error", message: INSTALL_USAGE };

  const raw: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!NEEDS_VALUE.has(flag)) {
      return { cmd: "error", message: `未知参数：${flag}\n\n${INSTALL_USAGE}` };
    }
    const value = rest[i + 1];
    // A missing value, or one that looks like the next flag, is a typo — not an
    // empty string the user meant.
    if (value === undefined || value.startsWith("--")) {
      return { cmd: "error", message: `${flag} 需要一个值\n\n${INSTALL_USAGE}` };
    }
    if (!validateEnvValue(value)) {
      return { cmd: "error", message: `${flag} 的值不能包含换行或控制字符（会写坏服务配置文件）` };
    }
    raw[flag] = value;
    i++;
  }

  const advertise = raw["--advertise"];
  if (!advertise) {
    return {
      cmd: "error",
      message:
        "缺少 --advertise。\n" +
        "它决定配对串里写的是哪个地址——不填的话手机拿到配对串也连不上这台机器。\n" +
        "例：--advertise wss://ps.example.com（走反代/隧道）或 --advertise ws://192.168.1.10:8722（局域网直连）\n\n" +
        INSTALL_USAGE,
    };
  }
  if (!advertise.startsWith("ws://") && !advertise.startsWith("wss://")) {
    return {
      cmd: "error",
      message: `--advertise 必须以 ws:// 或 wss:// 开头（收到：${advertise}）。\nHTTPS 站点填 wss://，明文 HTTP 填 ws://。`,
    };
  }

  let port = 8722;
  if (raw["--port"] !== undefined) {
    const n = Number(raw["--port"]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { cmd: "error", message: `--port 端口必须是 1..65535 的整数（收到：${raw["--port"]}）` };
    }
    port = n;
  }

  return {
    cmd: "install",
    opts: {
      advertise,
      name: raw["--name"],
      user: raw["--user"],
      host: raw["--host"] ?? "127.0.0.1",
      port,
    },
  };
}
