// app/src/demo/wiring.test.ts
// 接线契约：App.svelte 的演示分支必须被编译期常量门控，横幅文案必须走 i18n。
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import zh from "../lib/i18n/zh";
import en from "../lib/i18n/en";

const APP = readFileSync(resolve(__dirname, "../App.svelte"), "utf8");

test("Connection 的构造被 VITE_POCKETSHELL_DEMO 三元门控", () => {
  expect(APP).toMatch(/import\.meta\.env\.VITE_POCKETSHELL_DEMO\s*===\s*["']1["']/);
});

test("演示分支走 createDemoConnection，真实分支仍是 new Connection", () => {
  expect(APP).toContain("createDemoConnection");
  expect(APP).toContain("new Connection({ url: wsUrl })");
});

test("横幅与断线按钮的文案都有中英双语词条", () => {
  const keys = ["banner", "tryOffline", "installCta"] as const;
  for (const k of keys) {
    expect(zh.demo[k], `zh 缺 demo.${k}`).toBeTruthy();
    expect(en.demo[k], `en 缺 demo.${k}`).toBeTruthy();
  }
});

test("横幅文案没有硬编码中文（必须走 $t）", () => {
  // 抓「演示沙盘」这类字面量直接出现在模板里的情况。
  const template = APP.slice(APP.indexOf("</script>"));
  expect(template).not.toMatch(/演示沙盘|demo sandbox/i);
});

test("演示态禁用设备管理与检查更新（避免访客点到必然报错的入口）", () => {
  const panel = readFileSync(resolve(__dirname, "../components/SettingsPanel.svelte"), "utf8");
  expect(panel).toMatch(/VITE_POCKETSHELL_DEMO\s*===\s*["']1["']/);
  expect(panel).toContain("demo.disabled");
});
