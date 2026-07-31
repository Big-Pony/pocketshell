import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { wireStatusline, unwireStatusline, readChain } from "./statusline-wire";

const bin = "/usr/local/bin/pocketshell-agent";
const ourCmd = `${bin} statusline`;

function fx(seed?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "sl-"));
  const settings = join(dir, "settings.json");
  const chain = join(dir, "statusline-chain.json");
  if (seed !== undefined) writeFileSync(settings, JSON.stringify(seed, null, 2));
  return { settings, chain };
}

test("无 statusLine 时直接写入我们的命令", () => {
  const { settings, chain } = fx({});
  expect(wireStatusline(settings, chain, bin).ok).toBe(true);
  const j = JSON.parse(readFileSync(settings, "utf8"));
  expect(j.statusLine).toEqual({ type: "command", command: ourCmd });
  expect(existsSync(chain)).toBe(false); // 没有要包装的东西
});

test("settings.json 不存在时可创建", () => {
  const { settings, chain } = fx();
  expect(wireStatusline(settings, chain, bin).ok).toBe(true);
  expect(JSON.parse(readFileSync(settings, "utf8")).statusLine.command).toBe(ourCmd);
});

test("已有他人的 statusLine 时链式包装，原命令存进 chain", () => {
  const { settings, chain } = fx({ statusLine: { type: "command", command: "~/my-bar.sh", padding: 2 } });
  expect(wireStatusline(settings, chain, bin).ok).toBe(true);
  const j = JSON.parse(readFileSync(settings, "utf8"));
  expect(j.statusLine.command).toBe(ourCmd);
  expect(readChain(chain)).toEqual({ command: "~/my-bar.sh", type: "command", padding: 2 });
});

test("wire 幂等：重复接线不会把自己包进 chain", () => {
  const { settings, chain } = fx({ statusLine: { type: "command", command: "~/my-bar.sh" } });
  wireStatusline(settings, chain, bin);
  wireStatusline(settings, chain, bin);
  wireStatusline(settings, chain, bin);
  expect(readChain(chain)?.command).toBe("~/my-bar.sh"); // 仍是最初那个，没被自己覆盖
  expect(JSON.parse(readFileSync(settings, "utf8")).statusLine.command).toBe(ourCmd);
});

test("unwire 还原用户原来的 statusLine 并删除 chain", () => {
  const { settings, chain } = fx({ statusLine: { type: "command", command: "~/my-bar.sh", padding: 2 } });
  wireStatusline(settings, chain, bin);
  expect(unwireStatusline(settings, chain, bin).ok).toBe(true);
  const j = JSON.parse(readFileSync(settings, "utf8"));
  expect(j.statusLine).toEqual({ type: "command", command: "~/my-bar.sh", padding: 2 });
  expect(existsSync(chain)).toBe(false);
});

test("unwire 在无 chain 时直接删掉 statusLine 字段", () => {
  const { settings, chain } = fx({});
  wireStatusline(settings, chain, bin);
  expect(unwireStatusline(settings, chain, bin).ok).toBe(true);
  const j = JSON.parse(readFileSync(settings, "utf8"));
  expect(j.statusLine).toBeUndefined();
});

test("unwire 不动别人后来设置的 statusLine", () => {
  const { settings, chain } = fx({});
  wireStatusline(settings, chain, bin);
  // 用户之后又自己改成了别的
  const j0 = JSON.parse(readFileSync(settings, "utf8"));
  j0.statusLine = { type: "command", command: "~/other.sh" };
  writeFileSync(settings, JSON.stringify(j0, null, 2));
  unwireStatusline(settings, chain, bin);
  expect(JSON.parse(readFileSync(settings, "utf8")).statusLine.command).toBe("~/other.sh");
});

test("wire 保留 settings.json 里的其他字段", () => {
  const { settings, chain } = fx({ model: "opus[1m]", hooks: { Notification: [] }, tui: "default" });
  wireStatusline(settings, chain, bin);
  const j = JSON.parse(readFileSync(settings, "utf8"));
  expect(j.model).toBe("opus[1m]");
  expect(j.tui).toBe("default");
  expect(j.hooks).toEqual({ Notification: [] });
});

test("settings.json 损坏时结构化报错，不覆盖用户文件", () => {
  const { settings, chain } = fx();
  writeFileSync(settings, "{ not json");
  const r = wireStatusline(settings, chain, bin);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("parse_error");
  expect(readFileSync(settings, "utf8")).toBe("{ not json"); // 原样未动
});

test("readChain 在文件不存在或损坏时返回 null", () => {
  const { chain } = fx();
  expect(readChain(chain)).toBeNull();
  writeFileSync(chain, "{ broken");
  expect(readChain(chain)).toBeNull();
});
