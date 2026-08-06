// app/src/demo/fs.test.ts
import { test, expect } from "vitest";
import { DEMO_ROOT, resolvePath, lookup, listDir, treeAt, readFile, langOf } from "./fs";

test("resolvePath：相对、绝对、. 与 .. 都解析正确", () => {
  expect(resolvePath(DEMO_ROOT, "src")).toBe(`${DEMO_ROOT}/src`);
  expect(resolvePath(DEMO_ROOT, "./src")).toBe(`${DEMO_ROOT}/src`);
  expect(resolvePath(`${DEMO_ROOT}/src`, "..")).toBe(DEMO_ROOT);
  expect(resolvePath(DEMO_ROOT, "/etc")).toBe("/etc");
  expect(resolvePath(DEMO_ROOT, "")).toBe(DEMO_ROOT);
  expect(resolvePath(DEMO_ROOT, ".")).toBe(DEMO_ROOT);
});

test("resolvePath：.. 越过根不会跑出 /（不能产出 /.. 这种路径）", () => {
  expect(resolvePath("/", "..")).toBe("/");
  expect(resolvePath("/a", "../../..")).toBe("/");
});

test("lookup：命中目录与文件，未命中回 null", () => {
  expect(lookup(DEMO_ROOT)?.type).toBe("dir");
  expect(lookup(`${DEMO_ROOT}/README.md`)?.type).toBe("file");
  expect(lookup(`${DEMO_ROOT}/nope.txt`)).toBeNull();
});

test("listDir：目录列出子项；对文件回 null", () => {
  const names = listDir(DEMO_ROOT)!.map((e) => e.name);
  expect(names).toContain("src");
  expect(names).toContain("README.md");
  expect(listDir(`${DEMO_ROOT}/README.md`)).toBeNull();
});

test("treeAt：惰性单层——只给直接子节点，子目录带 hasChildren", () => {
  const r = treeAt(DEMO_ROOT)!;
  expect(r.path).toBe(DEMO_ROOT);
  const src = r.nodes.find((n) => n.name === "src")!;
  expect(src.type).toBe("dir");
  expect(src.hasChildren).toBe(true);
  // 不该把孙子节点也铺进来
  expect(r.nodes.some((n) => n.name === "auth.ts")).toBe(false);
});

test("treeAt：带 git 标记的文件把标记透出来（文件树内联标记靠它）", () => {
  const r = treeAt(`${DEMO_ROOT}/src`)!;
  expect(r.nodes.find((n) => n.name === "auth.ts")!.git).toBe("M");
});

test("readFile：回内容 + lang；对目录回 null", () => {
  const f = readFile(`${DEMO_ROOT}/README.md`)!;
  expect(f.content.length).toBeGreaterThan(0);
  expect(f.lang).toBe("markdown");
  expect(readFile(DEMO_ROOT)).toBeNull();
});

test("langOf：按扩展名给 highlight.js 认得的语言名", () => {
  expect(langOf("a.ts")).toBe("typescript");
  expect(langOf("a.md")).toBe("markdown");
  expect(langOf("a.json")).toBe("json");
  expect(langOf("a.html")).toBe("xml");
  expect(langOf("Makefile")).toBe("plaintext");
});

test("树里有演示需要的四类文件：ts / md / 图片 / html", () => {
  // 少任何一类，对应的预览分支就演示不到（设计文档 4.5）。
  expect(lookup(`${DEMO_ROOT}/src/auth.ts`)).not.toBeNull();
  expect(lookup(`${DEMO_ROOT}/README.md`)).not.toBeNull();
  expect(lookup(`${DEMO_ROOT}/docs/logo.png`)).not.toBeNull();
  expect(lookup(`${DEMO_ROOT}/docs/report.html`)).not.toBeNull();
});

test("README 内容跟随 locale 切换（惰性求值守卫，勿改回模块级常量）", async () => {
  const { locale } = await import("svelte-i18n");
  const zhText = readFile(`${DEMO_ROOT}/README.md`)!.content;
  locale.set("en");
  const enText = readFile(`${DEMO_ROOT}/README.md`)!.content;
  locale.set("zh"); // 复位，免得污染同文件后续用例（vitest-setup 钉死 zh）
  expect(zhText).not.toBe(enText);
  expect(enText).toContain("Everything here is fake");
  expect(zhText).toContain("这里的一切都是假的");
});
