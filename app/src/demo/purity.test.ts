// app/src/demo/purity.test.ts
// 生产包纯净性：真实构建绝不能含演示代码。
//
// 第一道防线是构建配置本身（真实构建不把 demo.html 放进 rollupOptions.input，
// 故整棵 src/demo/** 不可达）。这个测试是**第二道**——它校验的是源码层面的
// 引用关系，不需要真的跑一次构建，所以在本地 `bun run test` 里就能挡住。
import { test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const SRC = resolve(__dirname, "..");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) yield* walk(abs);
    else if (/\.(ts|svelte)$/.test(name)) yield abs;
  }
}

/** 除了这些，任何文件都不该 import src/demo/。 */
const ALLOWED_IMPORTERS = [
  "src/demo-main.ts",   // 展台页入口
  "src/App.svelte",     // 唯一的三元分支，且被 VITE_POCKETSHELL_DEMO 门控
];

test("除白名单外，没有文件 import src/demo/", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = file.slice(resolve(SRC, "..").length + 1);
    if (rel.startsWith("src/demo/")) continue;          // demo 内部互相引用当然可以
    if (ALLOWED_IMPORTERS.includes(rel)) continue;
    const text = readFileSync(file, "utf8");
    if (/from\s+["'][^"']*\/demo\/|from\s+["']\.\/demo["']/.test(text)) offenders.push(rel);
  }
  expect(offenders, "这些文件会把演示代码拖进生产包").toEqual([]);
});

test("App.svelte 里对 demo 的 import 被 VITE_POCKETSHELL_DEMO 门控", () => {
  // 没有门控的话 tree-shaking 保不住，演示代码会静默进生产包。
  const app = readFileSync(resolve(SRC, "App.svelte"), "utf8");
  if (!/\/demo/.test(app)) return; // Task 8 之前还没接线
  expect(app).toContain("VITE_POCKETSHELL_DEMO");
});

test("demo 目录不 import 任何组件（保持纯 TS，可单测、不拖 UI 进来）", () => {
  const offenders: string[] = [];
  for (const file of walk(join(SRC, "demo"))) {
    const text = readFileSync(file, "utf8");
    if (/from\s+["'][^"']*\.svelte["']/.test(text)) offenders.push(file.slice(SRC.length + 1));
  }
  expect(offenders).toEqual([]);
});
