import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { wireClaude, unwireClaude, wireCodex, unwireCodex, wireOpencode, unwireOpencode, wireKimi, unwireKimi } from "./notify-wire";

const bin = "/usr/local/bin/pocketshell-agent";
const cmd = `${bin} notify claude`;

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
  wireClaude(f, bin); unwireClaude(f, bin);
  const j = JSON.parse(readFileSync(f, "utf8"));
  const cmds = j.hooks.Notification.flatMap((e: any) => e.hooks.map((h: any) => h.command));
  expect(cmds).toContain("user-notify");
  expect(cmds).not.toContain(cmd);
});

test("unwire keeps user hook that also ends with ' notify' (exact-match only)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  const f = join(dir, "settings.json");
  writeFileSync(f, JSON.stringify({ hooks: { Notification: [{ matcher: "", hooks: [{ type: "command", command: "deploy notify" }] }] } }));
  wireClaude(f, bin); unwireClaude(f, bin);
  const j = JSON.parse(readFileSync(f, "utf8"));
  const cmds = j.hooks.Notification.flatMap((e: any) => e.hooks.map((h: any) => h.command));
  expect(cmds).toContain("deploy notify");
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
  expect(txt.split("\n")[0]).toBe(`notify = ["${bin}", "notify", "codex"]`); // before [tui]
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

test("opencode wire writes plugin file", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-"));         // stands in for ~/.config/opencode
  const pluginDir = join(dir, "plugin");
  const r = wireOpencode(pluginDir);
  expect(r.ok).toBe(true);
  expect(existsSync(join(pluginDir, "pocketshell-notify.js"))).toBe(true);
});

test("opencode missing base -> opencode_not_found", () => {
  const r = wireOpencode(join(tmpdir(), "no-such-oc-xyz", "plugin"));
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("opencode_not_found");
});

test("opencode unwire deletes plugin file", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-"));
  const pluginDir = join(dir, "plugin");
  wireOpencode(pluginDir); unwireOpencode(pluginDir);
  expect(existsSync(join(pluginDir, "pocketshell-notify.js"))).toBe(false);
});

test("opencode 插件源码里带上 token 上报字段", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-"));
  const pluginDir = join(dir, "plugin");
  wireOpencode(pluginDir);
  const src = readFileSync(join(pluginDir, "pocketshell-notify.js"), "utf8");
  expect(src).toContain("ctxUsed");
  expect(src).toContain('tool: "opencode"');
  // ctxTotal 刻意不带：插件里拿不到当前模型的窗口大小（要查 models.dev
  // 的 catalog），编造一个假总量比不显示更糟。分割条会退化为只显示已用，
  // 这是 formatContext 已覆盖的设计路径。
  expect(src).not.toContain("ctxTotal");
  // 取不到 token 也必须发通知——token 是搭车的，不能反过来卡住主线
  expect(src).toContain("session.idle");
  expect(src).toContain("catch");
});

// kimi 的接线判定「已安装」的依据是 configPath 的父目录（~/.kimi）存在，
// 与 opencode 的 opencode_not_found 同款保守策略：不给未装的工具建目录。
function kimiFx(seed?: string) {
  const home = mkdtempSync(join(tmpdir(), "km-"));
  const kimiDir = join(home, ".kimi");
  mkdirSync(kimiDir, { recursive: true });
  const f = join(kimiDir, "config.toml");
  if (seed !== undefined) writeFileSync(f, seed);
  return f;
}

test("kimi wire 写入 Stop hook", () => {
  const f = kimiFx("");
  const r = wireKimi(f, bin);
  expect(r.ok).toBe(true);
  const txt = readFileSync(f, "utf8");
  expect(txt).toContain("# pocketshell-notify");
  expect(txt).toContain("[[hooks]]");
  expect(txt).toContain(`event = "Stop"`);
  expect(txt).toContain(`command = "${bin} notify kimi"`);
});

test("kimi wire 只写 event 和 command 两个字段（多写会让 kimi 启动失败）", () => {
  const f = kimiFx("");
  wireKimi(f, bin);
  const txt = readFileSync(f, "utf8");
  expect(txt).not.toContain("matcher");
  expect(txt).not.toContain("timeout");
});

test("kimi wire 幂等", () => {
  const f = kimiFx("");
  wireKimi(f, bin); wireKimi(f, bin); wireKimi(f, bin);
  const n = readFileSync(f, "utf8").split("# pocketshell-notify").length - 1;
  expect(n).toBe(1);
});

test("kimi wire 保留用户已有配置与 hooks", () => {
  const f = kimiFx(`default_model = "kimi-code/k3"\ntheme = "dark"\n\n[[hooks]]\nevent = "PreToolUse"\ncommand = "my-check.sh"\n`);
  const r = wireKimi(f, bin);
  expect(r.ok).toBe(true);
  const txt = readFileSync(f, "utf8");
  expect(txt).toContain(`default_model = "kimi-code/k3"`);
  expect(txt).toContain(`theme = "dark"`);
  expect(txt).toContain(`command = "my-check.sh"`);
  expect(txt).toContain(`command = "${bin} notify kimi"`);
});

test("kimi unwire 只删我们那块，保留用户 hooks", () => {
  const f = kimiFx(`[[hooks]]\nevent = "PreToolUse"\ncommand = "my-check.sh"\n`);
  wireKimi(f, bin);
  const r = unwireKimi(f);
  expect(r.ok).toBe(true);
  const txt = readFileSync(f, "utf8");
  expect(txt).toContain(`command = "my-check.sh"`);
  expect(txt).toContain(`event = "PreToolUse"`);
  expect(txt).not.toContain("# pocketshell-notify");
  expect(txt).not.toContain(`${bin} notify`);
});

test("kimi unwire 后用户在我们块之后的配置仍在", () => {
  const f = kimiFx("");
  wireKimi(f, bin);
  // 用户之后又手动加了一段
  writeFileSync(f, readFileSync(f, "utf8") + `\n[[hooks]]\nevent = "SessionStart"\ncommand = "hello.sh"\n`);
  unwireKimi(f);
  const txt = readFileSync(f, "utf8");
  expect(txt).toContain(`command = "hello.sh"`);
  expect(txt).not.toContain(`${bin} notify`);
});

test("kimi unwire 幂等（未接线时不报错）", () => {
  const f = kimiFx(`theme = "dark"\n`);
  expect(unwireKimi(f).ok).toBe(true);
  expect(readFileSync(f, "utf8")).toContain(`theme = "dark"`);
});

test("kimi 未安装（~/.kimi 不存在）返回 kimi_not_found", () => {
  const home = mkdtempSync(join(tmpdir(), "km-"));
  const f = join(home, ".kimi", "config.toml"); // 目录刻意不建
  const r = wireKimi(f, bin);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("kimi_not_found");
});

test("kimi 配置文件不存在但目录在时可创建", () => {
  const f = kimiFx(); // 不 seed，文件不存在
  expect(existsSync(f)).toBe(false);
  const r = wireKimi(f, bin);
  expect(r.ok).toBe(true);
  expect(readFileSync(f, "utf8")).toContain(`event = "Stop"`);
});

test("kimi unwire 文件不存在时直接成功", () => {
  const f = kimiFx();
  expect(unwireKimi(f).ok).toBe(true);
});
