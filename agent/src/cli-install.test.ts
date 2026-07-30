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
