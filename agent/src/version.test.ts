import { test, expect } from "bun:test";
import { AGENT_VERSION, BUILD_SHA } from "./version";
import pkg from "../package.json";

// 【2026-08-28】版本串允许 `-<git短SHA>` 后缀：SW 按版本桶缓存，版本号不变
// 就不换桶，曾在未 bump 版本号的部署上让 PWA 一直跑旧包。测试环境不注入
// PS_BUILD_SHA，这里走的正是「无 SHA 退化」分支；后缀行为由 build-bin 注入
// 后的运行时体现（AGENT_VERSION 与前端 __APP_VERSION__ 同源同格式）。
test("AGENT_VERSION matches package.json semver", () => {
  expect(AGENT_VERSION).toBe(pkg.version);
  expect(AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(BUILD_SHA).toBe("");
});

test("带 SHA 后缀的版本串仍能被 OTA 的 semver 解析器判等", async () => {
  const { compareSemver, hasUpdate } = await import("./update-core");
  const suffixed = `${pkg.version}-8df0fa2`;
  // 与同号 release tag 判等（不误报更新），与更高号判旧（不漏报）。
  expect(compareSemver(suffixed, `v${pkg.version}`)).toBe(0);
  expect(hasUpdate(suffixed, `v${pkg.version}`)).toBe(false);
  const [a, b, c] = pkg.version.split(".").map(Number);
  const newer = `v${a}.${b}.${c + 1}`;
  if (c < 99) expect(hasUpdate(suffixed, newer)).toBe(true);
});
