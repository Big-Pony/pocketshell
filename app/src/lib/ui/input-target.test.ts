import { describe, it, expect } from "vitest";
import { inputTarget } from "./input-target";

// 键盘/输入法/片段面板发出的文本该打进哪个会话。
//
// 这条 bug 的现场（2026-08-09 用户真机报告）：在多个 tab 之间切换后用输入法
// 缓冲发送，文本进了**之前切过的某个终端**而不是当前聚焦的那个。
//
// 根因是 App.svelte 里存在两个「当前」：
//   - activeTopId  决定**渲染**哪个 tab（`active={activeTopId === s.name}`）
//   - activeId     决定**发往**哪个会话（`conn.sendInput(activeId, ...)`）
// 切终端时 selectTop 会调 selectSession 把两者同步；但切到**文件 tab** 时
// 只设 activeTop、不动 activeId（App.svelte:646），于是「看到的」和「发到的」
// 分叉——键盘还打向上一个终端。
describe("inputTarget", () => {
  it("终端 tab 聚焦时打向它自己", () => {
    expect(inputTarget("work")).toBe("work");
  });

  it("文件 tab 聚焦时不发给任何会话 —— 这是本 bug 的核心", () => {
    // 聚焦在文件预览上，activeId 还停在上一个终端 "work"。
    // 旧行为返回 "work"（文本静默打进看不见的终端）；正确行为是不发。
    expect(inputTarget("file:code:/a.ts")).toBeNull();
  });

  it("文件 tab 聚焦时，即便 activeId 是空也一样不发", () => {
    expect(inputTarget("file:diff:/b.ts")).toBeNull();
  });

  it("没有任何聚焦 tab 时不发", () => {
    expect(inputTarget("")).toBeNull();
  });

  it("聚焦的终端与 activeId 不一致时，以**聚焦的那个**为准", () => {
    // 防回潮：任何让两者分叉的新路径（closeFile 的回落分支就是一个）
    // 都不该让输入打到看不见的会话上。
    expect(inputTarget("b")).toBe("b");
  });
});
