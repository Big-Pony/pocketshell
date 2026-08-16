// Guardrail: the very first command install.sh tells you to run must actually
// be runnable. It was not, from the first version (bbda5c7) until 2026-08-17:
// a non-root Linux user got
//
//     sudo: pocketshell-agent: command not found
//
// on step one. Two independent reasons, and the old text acknowledged neither
// correctly (it said "use the full path below" while printing a bare name):
//   1. install.sh puts the binary in ~/.local/bin when not root, and that is
//      usually not on PATH;
//   2. even when it IS on PATH, `sudo` replaces PATH with secure_path, which
//      never contains a home directory. So `pocketshell-agent …` can work while
//      `sudo pocketshell-agent …` fails on the same machine.
//
// Nothing tested the script's output, so the bug survived a full English
// rewrite that touched these exact lines. This file is that test.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../../install.sh"), "utf8");

/**
 * Runs only the trailing "what to do next" section, with the environment a
 * given machine would have. Everything above `installed_version=` (download,
 * checksum, extract) is skipped.
 */
async function tail(env: { os_part: string; BIN_DIR: string; PATH: string; uid: string }): Promise<string> {
  const start = SRC.indexOf("installed_version=");
  expect(start).toBeGreaterThan(0);
  const body = SRC.slice(start);
  const script = [
    `os_part='${env.os_part}'`,
    `BIN_DIR='${env.BIN_DIR}'`,
    `PATH='${env.PATH}'`,
    `REPO=Big-Pony/pocketshell`,
    `say() { printf '%s\\n' "$*"; }`,
    `id() { echo '${env.uid}'; }`,
    body,
  ].join("\n");
  const proc = Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

/** The command lines the user is told to run (indented four spaces). */
function commands(out: string): string[] {
  return out.split("\n").filter((l) => l.startsWith("    ")).map((l) => l.trim());
}

test("non-root Linux: every suggested command is an absolute path", async () => {
  // sudo's secure_path never has ~/.local/bin, so a bare name cannot work here
  // no matter what the user's own PATH says.
  const out = await tail({ os_part: "linux", BIN_DIR: "/home/u/.local/bin", PATH: "/usr/bin:/bin", uid: "1000" });
  const cmds = commands(out);
  expect(cmds.length).toBeGreaterThan(0);
  for (const c of cmds) {
    expect(c.startsWith("sudo /home/u/.local/bin/pocketshell-agent")).toBe(true);
  }
});

test("non-root Linux: absolute path is used even when BIN_DIR is on PATH", async () => {
  // The trap: the user's PATH is irrelevant once sudo is involved.
  const out = await tail({ os_part: "linux", BIN_DIR: "/home/u/.local/bin", PATH: "/home/u/.local/bin:/usr/bin", uid: "1000" });
  for (const c of commands(out)) expect(c).toContain("/home/u/.local/bin/pocketshell-agent");
});

test("root Linux: /usr/local/bin is on secure_path, so the bare name is fine", async () => {
  const out = await tail({ os_part: "linux", BIN_DIR: "/usr/local/bin", PATH: "/usr/local/bin:/usr/bin", uid: "0" });
  const cmds = commands(out);
  expect(cmds.length).toBeGreaterThan(0);
  for (const c of cmds) expect(c.startsWith("pocketshell-agent")).toBe(true);
});

test("macOS: never suggests sudo (a LaunchAgent lives in the user domain)", async () => {
  // cli-install.ts:199-202 hard-rejects sudo on darwin; suggesting it would
  // walk the user straight into an error.
  const out = await tail({ os_part: "darwin", BIN_DIR: "/Users/u/.local/bin", PATH: "/usr/bin:/bin", uid: "501" });
  for (const c of commands(out)) expect(c.startsWith("sudo ")).toBe(false);
});

test("macOS off PATH: uses the absolute path so the command resolves", async () => {
  const out = await tail({ os_part: "darwin", BIN_DIR: "/Users/u/.local/bin", PATH: "/usr/bin:/bin", uid: "501" });
  for (const c of commands(out)) expect(c).toContain("/Users/u/.local/bin/pocketshell-agent");
});

test("macOS is never promised a PATH entry — install makes no symlink there", async () => {
  // resolvePlan only sets symlinkPath on linux (cli-install.ts:190). Claiming
  // otherwise on darwin would be a lie the next command exposes.
  const out = await tail({ os_part: "darwin", BIN_DIR: "/Users/u/.local/bin", PATH: "/usr/bin:/bin", uid: "501" });
  expect(out).not.toContain("puts pocketshell-agent on your PATH");
});

test("both paths are offered: with a domain, and without one", async () => {
  const out = await tail({ os_part: "linux", BIN_DIR: "/usr/local/bin", PATH: "/usr/local/bin", uid: "0" });
  expect(out).toContain("wss://your.domain");
  expect(out).toContain("tunnel setup");
});
