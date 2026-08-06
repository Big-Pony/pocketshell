// app/src/demo/i18n-coverage.test.ts
// 演示数据里不得再出现硬编码中文——它们必须走 i18n（设计 §2）。
//
// 只扫**字符串字面量**：本仓库代码注释一律中文，那是给维护者看的，不是产品文案。
import { test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const DEMO = resolve(__dirname);
const CJK = /[一-鿿]/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) yield* walk(abs);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) yield abs;
  }
}

/**
 * 剥掉注释，只留代码。顺序很重要：先删块注释再删行注释，
 * 否则块注释里的 `//` 会把删除范围截断。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("src/demo/** 的字符串字面量里没有硬编码中文", () => {
  const offenders: string[] = [];
  for (const file of walk(DEMO)) {
    const code = stripComments(readFileSync(file, "utf8"));
    code.split("\n").forEach((line, i) => {
      if (CJK.test(line)) offenders.push(`${file.slice(DEMO.length + 1)}:${i + 1}  ${line.trim()}`);
    });
  }
  expect(offenders, `演示数据里有硬编码中文，应改走 i18n（见设计 §2）：\n${offenders.join("\n")}`).toEqual([]);
});
