// 结构性防线：把「不能再用 term.reset() 清屏」钉进测试。
//
// 这个 bug 修过一次又回来了（clear() → reset() 那次是误诊，见 reseed.ts 顶部
// 注释）。光靠注释拦不住下一个人 —— 所以扫源码。同 app.css.test.ts 扫硬编码
// 颜色的既有做法。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * 扫描前先去掉注释。
 *
 * 必须去：Terminal.svelte 里那段「此前用 term.reset() 清屏，那是错的」的历史
 * 注记本身就含有 `term.reset(`，不剥注释这条断言会被自己的文档钉死 —— 而那段
 * 注记恰恰是最该留下的东西（它解释了为什么不能改回去）。
 * 只剥注释、不剥字符串：本仓库没有把 `term.reset(` 放进字符串字面量的场景，
 * 真出现了也该当成回潮拦下来。
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("防回潮：清屏必须走流内 RIS", () => {
  it("Terminal.svelte 里不得出现 term.reset()", () => {
    const src = stripComments(read("../../components/Terminal.svelte"));
    // reset() 是同步的、且不清 xterm 的写队列；排队中的实时字节会穿透它，
    // 与随后写入的快照熔成一行（真机症状 p8rmissions）。用 buildReseedPayload。
    expect(src).not.toMatch(/\bterm\.reset\s*\(/);
  });

  it("RIS 必须与内容拼在同一个字符串里 —— buildReseedPayload 是唯一出口", () => {
    const src = read("./reseed.ts");
    // 只允许 buildReseedPayload 里出现 RIS 常量；组件里不得自行拼装。
    const comp = read("../../components/Terminal.svelte");
    expect(comp).not.toContain("\\x1bc");
    expect(src).toContain("const RIS");
  });
});
