import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { wireClaude, unwireClaude, wireCodex, unwireCodex } from "./notify-wire";

const bin = "/usr/local/bin/pocketshell-agent";
const cmd = `${bin} notify`;

test("wire into empty/missing settings creates Notification hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  const f = join(dir, "settings.json");
  const r = wireClaude(f, bin);
  expect(r.ok).toBe(true);
  const j = JSON.parse(readFileSync(f, "utf8"));
  const cmds = j.hooks.Notification.flatMap((e: any) => e.hooks.map((h: any) => h.command));
  expect(cmds).toContain(cmd);
});

test("wire is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  const f = join(dir, "settings.json");
  wireClaude(f, bin); wireClaude(f, bin);
  const j = JSON.parse(readFileSync(f, "utf8"));
  const count = j.hooks.Notification.flatMap((e: any) => e.hooks).filter((h: any) => h.command === cmd).length;
  expect(count).toBe(1);
});

test("unwire removes only our hook, keeps user hooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  const f = join(dir, "settings.json");
  writeFileSync(f, JSON.stringify({ hooks: { Notification: [{ matcher: "", hooks: [{ type: "command", command: "user-notify" }] }] } }));
  wireClaude(f, bin); unwireClaude(f);
  const j = JSON.parse(readFileSync(f, "utf8"));
  const cmds = j.hooks.Notification.flatMap((e: any) => e.hooks.map((h: any) => h.command));
  expect(cmds).toContain("user-notify");
  expect(cmds).not.toContain(cmd);
});

test("malformed settings.json surfaces error", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  const f = join(dir, "settings.json");
  writeFileSync(f, "{ not json");
  const r = wireClaude(f, bin);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("parse_error");
});

test("codex wire inserts notify as first line", () => {
  const dir = mkdtempSync(join(tmpdir(), "cx-"));
  const f = join(dir, "config.toml");
  writeFileSync(f, "[tui]\nnotifications = []\n");
  const r = wireCodex(f, bin);
  expect(r.ok).toBe(true);
  const txt = readFileSync(f, "utf8");
  expect(txt.split("\n")[0]).toBe(`notify = ["${bin}", "notify"]`); // before [tui]
});

test("codex wire is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cx-"));
  const f = join(dir, "config.toml");
  wireCodex(f, bin); wireCodex(f, bin);
  const n = readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("notify =")).length;
  expect(n).toBe(1);
});

test("codex existing foreign notify -> conflict", () => {
  const dir = mkdtempSync(join(tmpdir(), "cx-"));
  const f = join(dir, "config.toml");
  writeFileSync(f, `notify = ["other"]\n`);
  const r = wireCodex(f, bin);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("conflict");
});

test("codex unwire removes our line only", () => {
  const dir = mkdtempSync(join(tmpdir(), "cx-"));
  const f = join(dir, "config.toml");
  writeFileSync(f, "[tui]\n");
  wireCodex(f, bin); unwireCodex(f);
  expect(readFileSync(f, "utf8")).not.toContain("notify =");
  expect(readFileSync(f, "utf8")).toContain("[tui]");
});
