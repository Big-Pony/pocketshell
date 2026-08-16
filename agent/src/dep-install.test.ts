import { test, expect } from "bun:test";
import { decideTailscaleInstall, TAILSCALE_INSTALL_URL, type DepDecision } from "./dep-install";

const base = { present: false, platform: "linux", isTTY: true, euid: 0, scriptPath: "/tmp/ts.sh" };

function msg(d: DepDecision): string {
  return d.action === "manual" ? d.message : "";
}

test("already installed -> nothing to do", () => {
  expect(decideTailscaleInstall({ ...base, present: true })).toEqual({ action: "present" });
});

test("already installed wins even without a TTY and without root", () => {
  // 探测在前，策略在后：装好了就不该因为环境不满足而报错。
  expect(decideTailscaleInstall({ ...base, present: true, isTTY: false, euid: 1000 }))
    .toEqual({ action: "present" });
});

test("linux + root + TTY -> download then run the official script, argv arrays only", () => {
  const d = decideTailscaleInstall(base);
  expect(d.action).toBe("install");
  const argv = (d as { argv: string[][] }).argv;
  expect(argv).toEqual([
    ["curl", "-fsSL", "-o", "/tmp/ts.sh", TAILSCALE_INSTALL_URL],
    ["sh", "/tmp/ts.sh"],
  ]);
  // 硬规：任何一条命令里都不能出现管道/重定向/分号 —— 那意味着有人拼了 shell 串。
  for (const cmd of argv) for (const word of cmd) expect(word).not.toMatch(/[|;&><]/);
});

test("no TTY -> never installs anything, prints the manual steps", () => {
  const d = decideTailscaleInstall({ ...base, isTTY: false });
  expect(d.action).toBe("manual");
  expect(msg(d)).toContain(TAILSCALE_INSTALL_URL);
});

test("linux without root -> tells the user to re-run with sudo, installs nothing", () => {
  const d = decideTailscaleInstall({ ...base, euid: 1000 });
  expect(d.action).toBe("manual");
  expect(msg(d)).toContain("sudo");
});

test("macOS -> guided install, never silent", () => {
  // macOS 上 tailscale 要么 App Store 版要么 brew + 独立 daemon，官方 install.sh
  // 不做无人值守安装。本期不假装能代办。
  const d = decideTailscaleInstall({ ...base, platform: "darwin", euid: 501 });
  expect(d.action).toBe("manual");
  expect(msg(d)).toContain("brew install tailscale");
  expect(msg(d)).not.toContain(TAILSCALE_INSTALL_URL);
});

test("unknown platform -> manual", () => {
  const d = decideTailscaleInstall({ ...base, platform: "freebsd" });
  expect(d.action).toBe("manual");
});
