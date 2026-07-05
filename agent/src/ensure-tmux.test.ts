import { test, expect } from "bun:test";
import { tmuxInstallHint, ensureTmux } from "./ensure-tmux";

test("tmuxInstallHint maps common distros from /etc/os-release", () => {
  expect(tmuxInstallHint('ID=ubuntu\nID_LIKE=debian\n', "linux")).toBe("sudo apt install -y tmux");
  expect(tmuxInstallHint('ID=debian\n', "linux")).toBe("sudo apt install -y tmux");
  expect(tmuxInstallHint('ID=fedora\n', "linux")).toBe("sudo dnf install -y tmux");
  expect(tmuxInstallHint('ID="rhel"\nID_LIKE="fedora"\n', "linux")).toBe("sudo dnf install -y tmux");
  expect(tmuxInstallHint('ID=arch\n', "linux")).toBe("sudo pacman -S tmux");
  expect(tmuxInstallHint('ID=alpine\n', "linux")).toBe("apk add tmux");
});

test("tmuxInstallHint uses brew on darwin regardless of os-release", () => {
  expect(tmuxInstallHint("", "darwin")).toBe("brew install tmux");
});

test("tmuxInstallHint falls back to a generic hint on unknown distro", () => {
  expect(tmuxInstallHint("ID=weirdos\n", "linux")).toMatch(/package manager/i);
});

test("ensureTmux returns quietly when tmux is present, never calls fail", () => {
  let failed = false;
  ensureTmux({ probe: () => true, readOsRelease: () => "", platform: "linux", fail: () => { failed = true; throw new Error("x"); } });
  expect(failed).toBe(false);
});

test("ensureTmux fails loud with the distro hint when tmux is missing", () => {
  let msg = "";
  expect(() =>
    ensureTmux({ probe: () => false, readOsRelease: () => "ID=ubuntu\n", platform: "linux", fail: (m) => { msg = m; throw new Error("exit"); } }),
  ).toThrow("exit");
  expect(msg).toContain("sudo apt install -y tmux");
  expect(msg).toMatch(/tmux not found/i);
});
