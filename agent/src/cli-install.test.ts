import { test, expect } from "bun:test";
import { parseInstallArgv, validateEnvValue } from "./cli-install";

const ok = (argv: string[]) => {
  const a = parseInstallArgv(argv);
  if (a.cmd !== "install") throw new Error(`expected install, got ${a.cmd}: ${JSON.stringify(a)}`);
  return a.opts;
};
const err = (argv: string[]) => {
  const a = parseInstallArgv(argv);
  if (a.cmd !== "error") throw new Error(`expected error, got ${a.cmd}`);
  return a.message;
};

test("minimal install: only --advertise, everything else defaults", () => {
  const o = ok(["install", "--advertise", "wss://linux.cf-blog.com"]);
  expect(o.advertise).toBe("wss://linux.cf-blog.com");
  expect(o.host).toBe("127.0.0.1");
  expect(o.port).toBe(8722);
  expect(o.name).toBeUndefined();
  expect(o.user).toBeUndefined();
});

test("all five flags parse", () => {
  const o = ok(["install",
    "--advertise", "ws://192.168.1.10:8722",
    "--name", "开发",
    "--user", "myt",
    "--host", "0.0.0.0",
    "--port", "9001",
  ]);
  expect(o).toEqual({ advertise: "ws://192.168.1.10:8722", name: "开发", user: "myt", host: "0.0.0.0", port: 9001 });
});

test("uninstall takes no flags", () => {
  expect(parseInstallArgv(["uninstall"])).toEqual({ cmd: "uninstall" });
});

test("--advertise is required and the error says why", () => {
  const m = err(["install"]);
  expect(m).toContain("--advertise");
  expect(m).toContain("配对串");   // explains WHY it is required
});

test("--advertise must be ws:// or wss://, not https://", () => {
  // High-frequency mistake: an https:// value silently produces a pairing
  // string the phone cannot connect to.
  expect(err(["install", "--advertise", "https://x.com"])).toContain("ws://");
  expect(err(["install", "--advertise", "x.com"])).toContain("ws://");
  expect(ok(["install", "--advertise", "ws://x.com"]).advertise).toBe("ws://x.com");
});

test("port must be an integer in 1..65535", () => {
  expect(err(["install", "--advertise", "wss://x.com", "--port", "0"])).toContain("端口");
  expect(err(["install", "--advertise", "wss://x.com", "--port", "70000"])).toContain("端口");
  expect(err(["install", "--advertise", "wss://x.com", "--port", "abc"])).toContain("端口");
  expect(err(["install", "--advertise", "wss://x.com", "--port", "80.5"])).toContain("端口");
});

test("values containing control characters are rejected", () => {
  // systemd's Environment= is line-based: a newline in any value could inject
  // arbitrary directives into the unit file.
  expect(err(["install", "--advertise", "wss://x.com\nExecStart=/bin/sh"])).toContain("控制字符");
  expect(err(["install", "--advertise", "wss://x.com", "--name", "a\rb"])).toContain("控制字符");
});

test("flags needing a value reject a missing or flag-shaped value", () => {
  expect(err(["install", "--advertise"])).toContain("--advertise");
  expect(err(["install", "--advertise", "--name"])).toContain("--advertise");
});

test("unknown flags are rejected rather than ignored", () => {
  expect(err(["install", "--advertise", "wss://x.com", "--bogus"])).toContain("--bogus");
});

test("validateEnvValue rejects control characters", () => {
  expect(validateEnvValue("wss://ok.com")).toBe(true);
  expect(validateEnvValue("开发")).toBe(true);
  expect(validateEnvValue("a\nb")).toBe(false);
  expect(validateEnvValue("a\rb")).toBe(false);
  expect(validateEnvValue("a\tb")).toBe(false);
  expect(validateEnvValue("a\x00b")).toBe(false);
  expect(validateEnvValue("a\x7fb")).toBe(false);
});

import { resolvePlan } from "./cli-install";
import type { InstallOpts, ResolveInput } from "./cli-install";

const OPTS: InstallOpts = { advertise: "wss://x.com", host: "127.0.0.1", port: 8722 };
const HOMES: Record<string, string> = { myt: "/home/myt", root: "/root", alice: "/home/alice" };
const BASE: ResolveInput = {
  platform: "linux",
  euid: 0,
  env: {},
  opts: OPTS,
  homeOf: (u: string) => HOMES[u] ?? null,
  tmuxDir: () => "/opt/homebrew/bin",
};
const plan = (i: Partial<ResolveInput>) => {
  const r = resolvePlan({ ...BASE, ...i });
  if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
  return r.plan;
};
const planErr = (i: Partial<ResolveInput>) => {
  const r = resolvePlan({ ...BASE, ...i });
  if (r.ok) throw new Error("expected error");
  return r.message;
};

test("linux: SUDO_USER becomes the service user, and keyDir follows its home", () => {
  // The phone gets THIS user's shell — dotfiles, claude/codex config, ssh keys.
  const p = plan({ env: { SUDO_USER: "myt" } });
  expect(p.user).toBe("myt");
  expect(p.home).toBe("/home/myt");
  expect(p.keyDir).toBe("/home/myt/.pocketshell");
  expect(p.binPath).toBe("/usr/local/bin/pocketshell-agent");
  expect(p.unitPath).toBe("/etc/systemd/system/pocketshell.service");
  expect(p.label).toBe("pocketshell");
});

test("linux: --user overrides SUDO_USER", () => {
  expect(plan({ env: { SUDO_USER: "myt" }, opts: { ...OPTS, user: "alice" } }).user).toBe("alice");
});

test("linux: direct root login (no SUDO_USER) falls back to root", () => {
  const p = plan({ env: {} });
  expect(p.user).toBe("root");
  expect(p.keyDir).toBe("/root/.pocketshell");
});

test("linux: non-root is rejected with a sudo hint", () => {
  expect(planErr({ euid: 1000, env: { SUDO_USER: "myt" } })).toContain("sudo");
});

test("linux: unknown --user is rejected before anything is written", () => {
  // systemd would fail with 217/USER, which means nothing to a user.
  expect(planErr({ env: {}, opts: { ...OPTS, user: "ghost" } })).toContain("ghost");
});

test("darwin: user-domain LaunchAgent under the invoking user's home", () => {
  const p = plan({ platform: "darwin", euid: 501, env: { USER: "myt", HOME: "/Users/myt" } });
  expect(p.user).toBe("myt");
  expect(p.binPath).toBe("/Users/myt/.local/bin/pocketshell-agent");
  expect(p.unitPath).toBe("/Users/myt/Library/LaunchAgents/com.pocketshell.agent.plist");
  expect(p.label).toBe("com.pocketshell.agent");
  expect(p.logPath).toBe("/Users/myt/Library/Logs/pocketshell.out.log");
  expect(p.tmuxDir).toBe("/opt/homebrew/bin");
});

test("darwin: running under sudo is refused", () => {
  // `launchctl bootstrap gui/$(id -u)` under sudo resolves to uid 0 — it would
  // either fail or install into a domain the user never sees.
  const m = planErr({ platform: "darwin", euid: 0, env: { SUDO_USER: "myt", USER: "root", HOME: "/var/root" } });
  expect(m).toContain("sudo");
});

test("darwin: missing tmux directory is reported (launchd PATH is minimal)", () => {
  const m = planErr({ platform: "darwin", euid: 501, env: { USER: "myt", HOME: "/Users/myt" }, tmuxDir: () => null });
  expect(m).toContain("tmux");
});

test("unsupported platform is refused", () => {
  expect(planErr({ platform: "win32" })).toContain("Linux");
});

test("env map carries exactly the POCKETSHELL_* the unit needs", () => {
  const p = plan({ env: { SUDO_USER: "myt" }, opts: { ...OPTS, name: "开发", host: "0.0.0.0", port: 9001 } });
  expect(p.env).toEqual({
    POCKETSHELL_HOST: "0.0.0.0",
    POCKETSHELL_PORT: "9001",
    POCKETSHELL_ADVERTISE: "wss://x.com",
    POCKETSHELL_KEY_DIR: "/home/myt/.pocketshell",
    POCKETSHELL_INSTANCE_NAME: "开发",
  });
});

test("env map omits INSTANCE_NAME entirely when --name is absent", () => {
  // "不设即维持现状" is a standing project constraint: no name -> no key at all,
  // not an empty string.
  const p = plan({ env: { SUDO_USER: "myt" } });
  expect(p.env.POCKETSHELL_INSTANCE_NAME).toBeUndefined();
  expect(Object.keys(p.env)).not.toContain("POCKETSHELL_INSTANCE_NAME");
});

import { renderSystemdUnit } from "./cli-install";

const linuxPlan = (over: Partial<InstallOpts> = {}) =>
  plan({ env: { SUDO_USER: "myt" }, opts: { ...OPTS, ...over } });

test("systemd unit: full expected text, byte for byte", () => {
  const unit = renderSystemdUnit(linuxPlan({ name: "开发" }));
  expect(unit).toBe(
`[Unit]
Description=PocketShell Agent
After=network.target

[Service]
Type=simple
User=myt
WorkingDirectory=/home/myt
ExecStart=/usr/local/bin/pocketshell-agent
Environment=POCKETSHELL_HOST=127.0.0.1
Environment=POCKETSHELL_PORT=8722
Environment=POCKETSHELL_ADVERTISE=wss://x.com
Environment=POCKETSHELL_KEY_DIR=/home/myt/.pocketshell
Environment=POCKETSHELL_INSTANCE_NAME=开发
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`);
});

test("systemd unit: Restart=always is present (OTA self-restart depends on it)", () => {
  // self-restart.ts detects systemd via INVOCATION_ID and exits, trusting the
  // supervisor to bring the new binary back up. Without Restart=always an
  // in-app update would simply stop the agent.
  expect(renderSystemdUnit(linuxPlan())).toContain("Restart=always");
});

test("systemd unit: no INSTANCE_NAME line when --name is absent", () => {
  expect(renderSystemdUnit(linuxPlan())).not.toContain("POCKETSHELL_INSTANCE_NAME");
});

test("systemd unit: honours --host/--port/--user overrides", () => {
  const u = renderSystemdUnit(plan({
    env: { SUDO_USER: "myt" },
    opts: { ...OPTS, user: "alice", host: "0.0.0.0", port: 9001 },
  }));
  expect(u).toContain("User=alice");
  expect(u).toContain("WorkingDirectory=/home/alice");
  expect(u).toContain("Environment=POCKETSHELL_HOST=0.0.0.0");
  expect(u).toContain("Environment=POCKETSHELL_PORT=9001");
  expect(u).toContain("Environment=POCKETSHELL_KEY_DIR=/home/alice/.pocketshell");
});

test("systemd unit: ends with exactly one trailing newline", () => {
  const u = renderSystemdUnit(linuxPlan());
  expect(u.endsWith("WantedBy=multi-user.target\n")).toBe(true);
  expect(u.endsWith("\n\n")).toBe(false);
});

import { renderLaunchdPlist } from "./cli-install";

const macPlan = (over: Partial<InstallOpts> = {}) =>
  plan({ platform: "darwin", euid: 501, env: { USER: "myt", HOME: "/Users/myt" }, opts: { ...OPTS, ...over } });

test("launchd plist: full expected text, byte for byte", () => {
  const p = renderLaunchdPlist(macPlan({ name: "家里" }));
  expect(p).toBe(
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pocketshell.agent</string>
  <key>ProgramArguments</key>
  <array><string>/Users/myt/.local/bin/pocketshell-agent</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>POCKETSHELL_HOST</key><string>127.0.0.1</string>
    <key>POCKETSHELL_PORT</key><string>8722</string>
    <key>POCKETSHELL_ADVERTISE</key><string>wss://x.com</string>
    <key>POCKETSHELL_KEY_DIR</key><string>/Users/myt/.pocketshell</string>
    <key>POCKETSHELL_INSTANCE_NAME</key><string>家里</string>
  </dict>
  <key>WorkingDirectory</key><string>/Users/myt</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/myt/Library/Logs/pocketshell.out.log</string>
  <key>StandardErrorPath</key><string>/Users/myt/Library/Logs/pocketshell.err.log</string>
</dict>
</plist>
`);
});

test("launchd plist: KeepAlive is present (OTA self-restart depends on it)", () => {
  expect(renderLaunchdPlist(macPlan())).toContain("<key>KeepAlive</key><true/>");
});

test("launchd plist: PATH leads with the detected tmux directory, not a hardcoded one", () => {
  // Intel Macs use /usr/local/bin, MacPorts /opt/local/bin — hardcoding
  // /opt/homebrew/bin (as the hand-written doc template does) breaks them.
  const r = resolvePlan({
    ...BASE, platform: "darwin", euid: 501,
    env: { USER: "myt", HOME: "/Users/myt" },
    tmuxDir: () => "/opt/local/bin",
  });
  if (!r.ok) throw new Error(r.message);
  expect(renderLaunchdPlist(r.plan)).toContain("<string>/opt/local/bin:/usr/local/bin:/usr/bin:/bin</string>");
});

test("launchd plist: no INSTANCE_NAME key when --name is absent", () => {
  expect(renderLaunchdPlist(macPlan())).not.toContain("POCKETSHELL_INSTANCE_NAME");
});

test("launchd plist: XML-escapes values (instance names may contain & or <)", () => {
  const p = renderLaunchdPlist(macPlan({ name: "A&B<C>" }));
  expect(p).toContain("<string>A&amp;B&lt;C&gt;</string>");
  expect(p).not.toContain("<string>A&B<C></string>");
});
