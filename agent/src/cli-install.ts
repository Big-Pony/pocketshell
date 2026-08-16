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
  "Usage:",
  "  pocketshell-agent install --advertise <address> [--name <instance>] [--user <user>] [--host <bind-addr>] [--port <port>]",
  "  pocketshell-agent uninstall",
  "",
  "  --advertise  Required. The external address baked into the pairing string, which is how your phone connects. Must start with ws:// or wss://.",
  "  --name       Instance name, to tell several installs apart (shown on the PWA icon and in the app's top bar).",
  "  --user       User the service runs as. Defaults to whoever invoked sudo on Linux, or the current user on macOS.",
  "  --host       Bind address, default 127.0.0.1 (keep it behind a reverse proxy; use 0.0.0.0 for a phone connecting straight over the LAN).",
  "  --port       Port, default 8722.",
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
    if (rest.length > 0) return { cmd: "error", message: `uninstall takes no arguments, got: ${rest[0]}\n\n${INSTALL_USAGE}` };
    return { cmd: "uninstall" };
  }
  if (sub !== "install") return { cmd: "error", message: INSTALL_USAGE };

  const raw: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!NEEDS_VALUE.has(flag)) {
      return { cmd: "error", message: `Unknown flag: ${flag}\n\n${INSTALL_USAGE}` };
    }
    const value = rest[i + 1];
    // A missing value, or one that looks like the next flag, is a typo — not an
    // empty string the user meant.
    if (value === undefined || value.startsWith("--")) {
      return { cmd: "error", message: `${flag} needs a value\n\n${INSTALL_USAGE}` };
    }
    if (!validateEnvValue(value)) {
      return { cmd: "error", message: `${flag} value must not contain newlines or control characters (they would corrupt the service config file)` };
    }
    raw[flag] = value;
    i++;
  }

  const advertise = raw["--advertise"];
  if (!advertise) {
    return {
      cmd: "error",
      message:
        "Missing --advertise.\n" +
        "It decides which address goes into the pairing string — without it your phone has nowhere to connect, even holding a valid code.\n" +
        "e.g. --advertise wss://ps.example.com (behind a reverse proxy / tunnel) or --advertise ws://192.168.1.10:8722 (straight over the LAN)\n\n" +
        INSTALL_USAGE,
    };
  }
  if (!advertise.startsWith("ws://") && !advertise.startsWith("wss://")) {
    return {
      cmd: "error",
      message: `--advertise must start with ws:// or wss:// (got: ${advertise}).\nUse wss:// for an HTTPS site, ws:// for plain HTTP.`,
    };
  }

  let port = 8722;
  if (raw["--port"] !== undefined) {
    const n = Number(raw["--port"]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { cmd: "error", message: `--port must be an integer in 1..65535 (got: ${raw["--port"]})` };
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
  /** Linux: the binary's directory is chown'd to this user so OTA can rename over it. */
  binOwner?: string;
  /** Linux: symlink on the global PATH pointing at binPath. */
  symlinkPath?: string;
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

// Where the Linux binary lives. Deliberately NOT /usr/local/bin: in-app OTA
// updates write `.pocketshell.new` next to the running binary and rename over
// it (see runApply in server.ts), so the service user needs write access to the
// *directory*, not just the file. /usr/local/bin is root-owned and chowning it
// to a normal user is not acceptable — so the binary gets its own directory,
// owned by whoever the service runs as.
//
// A symlink at /usr/local/bin/pocketshell-agent keeps the command on the global
// PATH, which matters because `sudo pocketshell-agent uninstall` resolves via
// root's PATH and would otherwise be command-not-found.
export const LINUX_BIN_DIR = "/opt/pocketshell";
export const LINUX_SYMLINK = "/usr/local/bin/pocketshell-agent";

export function resolvePlan(i: ResolveInput): { ok: true; plan: InstallPlan } | { ok: false; message: string } {
  if (i.platform === "linux") {
    if (i.euid !== 0) {
      return { ok: false, message: `install needs root (it writes ${LINUX_BIN_DIR}, /etc/systemd/system and ${LINUX_SYMLINK}).\nRun it as: sudo pocketshell-agent install …` };
    }
    const user = i.opts.user ?? i.env.SUDO_USER ?? "root";
    const home = i.homeOf(user);
    if (!home) {
      return { ok: false, message: `No such user on this system: "${user}". Pass --user with an existing account.` };
    }
    const keyDir = `${home}/.pocketshell`;
    return {
      ok: true,
      plan: {
        platform: "linux",
        user,
        home,
        keyDir,
        binPath: `${LINUX_BIN_DIR}/pocketshell-agent`,
        binOwner: user,
        symlinkPath: LINUX_SYMLINK,
        unitPath: `/etc/systemd/system/${SYSTEMD_UNIT_NAME}.service`,
        label: SYSTEMD_UNIT_NAME,
        env: buildEnv(i.opts, keyDir),
      },
    };
  }

  if (i.platform === "darwin") {
    if (i.env.SUDO_USER || i.euid === 0) {
      // `launchctl bootstrap gui/$(id -u)` under sudo targets uid 0's GUI domain.
      return { ok: false, message: "Do not use sudo on macOS — a LaunchAgent lives in your user domain, and under sudo it would be installed into root's session (invisible and useless to you).\nRe-run without sudo: pocketshell-agent install …" };
    }
    const user = i.opts.user ?? i.env.USER ?? "";
    const home = i.opts.user ? i.homeOf(i.opts.user) : (i.env.HOME ?? null);
    if (!user || !home) {
      return { ok: false, message: `Could not determine the home directory${i.opts.user ? ` (--user ${i.opts.user})` : ""}.` };
    }
    const dir = i.tmuxDir();
    if (!dir) {
      return { ok: false, message: "tmux not found. launchd's PATH is minimal, so tmux's directory has to be baked into the service config — which means tmux must already be in place before installing.\nInstall it first: brew install tmux" };
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

  return { ok: false, message: `Unsupported platform: ${i.platform}. install currently supports Linux (systemd) and macOS (launchd) only.` };
}

// Renders the system-level unit. System level (not user level) is deliberate:
// a user unit dies when the ssh session ends unless lingering is enabled, and
// Linger=no is the default on stock Ubuntu (verified on the dev server).
//
// Restart=always is load-bearing, not boilerplate: self-restart.ts hands OTA
// restarts to the supervisor, so without it an in-app update just stops the
// agent instead of coming back on the new binary.
export function renderSystemdUnit(plan: InstallPlan): string {
  const envLines = Object.entries(plan.env).map(([k, v]) => `Environment=${k}=${v}`);
  return [
    "[Unit]",
    "Description=PocketShell Agent",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${plan.user}`,
    `WorkingDirectory=${plan.home}`,
    `ExecStart=${plan.binPath}`,
    ...envLines,
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Renders the user-domain LaunchAgent. Two details are load-bearing:
//   PATH      launchd's environment is minimal; without tmux's directory the
//             agent exits at startup (ensure-tmux.ts fails loud). The directory
//             is probed at install time rather than hardcoded to
//             /opt/homebrew/bin, which only holds on Apple Silicon + Homebrew.
//   KeepAlive the launchd counterpart of Restart=always — OTA self-restart
//             hands the relaunch to launchd (see self-restart.ts).
export function renderLaunchdPlist(plan: InstallPlan): string {
  const path = `${plan.tmuxDir ?? "/usr/local/bin"}:/usr/local/bin:/usr/bin:/bin`;
  const envEntries = [["PATH", path], ...Object.entries(plan.env)];
  const envLines = envEntries.map(
    ([k, v]) => `    <key>${k}</key><string>${xmlEscape(v)}</string>`,
  );
  const logOut = plan.logPath ?? `${plan.home}/Library/Logs/pocketshell.out.log`;
  const logErr = logOut.replace(/\.out\.log$/, ".err.log");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${plan.label}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array><string>${xmlEscape(plan.binPath)}</string></array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...envLines,
    `  </dict>`,
    `  <key>WorkingDirectory</key><string>${xmlEscape(plan.home)}</string>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key><true/>`,
    `  <key>StandardOutPath</key><string>${xmlEscape(logOut)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(logErr)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}
