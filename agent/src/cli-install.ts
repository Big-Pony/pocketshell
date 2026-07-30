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

export interface InstallPlan {
  platform: "linux" | "darwin";
  /** Service runs as this user; the phone gets this user's shell. */
  user: string;
  home: string;
  keyDir: string;
  binPath: string;
  unitPath: string;
  /** launchd Label / systemd unit name stem. */
  label: string;
  /** darwin only: StandardOutPath, also where install reads the pairing string. */
  logPath?: string;
  env: Record<string, string>;
  /** darwin only: prepended to the plist PATH so launchd can find tmux. */
  tmuxDir?: string;
}

export interface ResolveInput {
  platform: string;
  euid: number;
  env: Record<string, string | undefined>;
  opts: InstallOpts;
  /** null when the user does not exist on this system. */
  homeOf: (user: string) => string | null;
  /** dirname of the tmux binary, or null when tmux is absent. */
  tmuxDir: () => string | null;
}

export const LAUNCHD_LABEL = "com.pocketshell.agent";
export const SYSTEMD_UNIT_NAME = "pocketshell";

function buildEnv(opts: InstallOpts, keyDir: string): Record<string, string> {
  const env: Record<string, string> = {
    POCKETSHELL_HOST: opts.host,
    POCKETSHELL_PORT: String(opts.port),
    POCKETSHELL_ADVERTISE: opts.advertise,
    // Written explicitly rather than left to the supervisor's HOME: it makes the
    // "install runs as root, service runs as <user>" split visible in the unit
    // file instead of hiding it in systemd's HOME derivation.
    POCKETSHELL_KEY_DIR: keyDir,
  };
  // Absent --name must produce NO key at all (project constraint: unset means
  // byte-for-byte identical behaviour to before the instance-name feature).
  if (opts.name) env.POCKETSHELL_INSTANCE_NAME = opts.name;
  return env;
}

export function resolvePlan(i: ResolveInput): { ok: true; plan: InstallPlan } | { ok: false; message: string } {
  if (i.platform === "linux") {
    if (i.euid !== 0) {
      return { ok: false, message: "install 需要 root 权限（要写 /etc/systemd/system 与 /usr/local/bin）。\n请改用：sudo pocketshell-agent install …" };
    }
    const user = i.opts.user ?? i.env.SUDO_USER ?? "root";
    const home = i.homeOf(user);
    if (!home) {
      return { ok: false, message: `系统里没有用户「${user}」。请用 --user 指定一个已存在的用户。` };
    }
    const keyDir = `${home}/.pocketshell`;
    return {
      ok: true,
      plan: {
        platform: "linux",
        user,
        home,
        keyDir,
        binPath: "/usr/local/bin/pocketshell-agent",
        unitPath: `/etc/systemd/system/${SYSTEMD_UNIT_NAME}.service`,
        label: SYSTEMD_UNIT_NAME,
        env: buildEnv(i.opts, keyDir),
      },
    };
  }

  if (i.platform === "darwin") {
    if (i.env.SUDO_USER || i.euid === 0) {
      // `launchctl bootstrap gui/$(id -u)` under sudo targets uid 0's GUI domain.
      return { ok: false, message: "macOS 上请不要用 sudo —— LaunchAgent 属于用户域，加 sudo 会装到 root 的会话里（你看不见也用不上）。\n请去掉 sudo 重新运行：pocketshell-agent install …" };
    }
    const user = i.opts.user ?? i.env.USER ?? "";
    const home = i.opts.user ? i.homeOf(i.opts.user) : (i.env.HOME ?? null);
    if (!user || !home) {
      return { ok: false, message: `无法确定 home 目录${i.opts.user ? `（--user ${i.opts.user}）` : ""}。` };
    }
    const dir = i.tmuxDir();
    if (!dir) {
      return { ok: false, message: "找不到 tmux。launchd 的 PATH 极简，必须把 tmux 所在目录写进服务配置，所以安装前 tmux 必须已就位。\n请先安装：brew install tmux" };
    }
    const keyDir = `${home}/.pocketshell`;
    return {
      ok: true,
      plan: {
        platform: "darwin",
        user,
        home,
        keyDir,
        binPath: `${home}/.local/bin/pocketshell-agent`,
        unitPath: `${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
        label: LAUNCHD_LABEL,
        logPath: `${home}/Library/Logs/pocketshell.out.log`,
        env: buildEnv(i.opts, keyDir),
        tmuxDir: dir,
      },
    };
  }

  return { ok: false, message: `不支持的平台：${i.platform}。install 目前只支持 Linux（systemd）与 macOS（launchd）。` };
}
