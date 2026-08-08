import { describe, it, expect } from "vitest";
import { buildReseedPayload, ReseedGate } from "./reseed";

describe("buildReseedPayload", () => {
  it("总是以 RIS 开头 —— 清空必须和内容在同一个字符串里", () => {
    expect(buildReseedPayload("hello")).toBe("\x1bchello");
  });

  it("把裸 \\n 规范成 \\r\\n（xterm 跑在 convertEol:false 下，裸 \\n 只下移不回列）", () => {
    expect(buildReseedPayload("a\nb")).toBe("\x1bca\r\nb");
  });

  it("不把已有的 \\r\\n 变成 \\r\\r\\n", () => {
    expect(buildReseedPayload("a\r\nb")).toBe("\x1bca\r\nb");
  });

  it("空内容也要带 RIS —— 快照为空意味着 pane 是空的，屏幕也该被清干净", () => {
    expect(buildReseedPayload("")).toBe("\x1bc");
  });
});

describe("ReseedGate", () => {
  it("首次 begin 返回 1，且不过期", () => {
    const g = new ReseedGate();
    const gen = g.begin();
    expect(gen).toBe(1);
    expect(g.isStale(gen)).toBe(false);
  });

  it("后一次 begin 让前一代过期 —— 旧快照必须被整份丢弃", () => {
    const g = new ReseedGate();
    const first = g.begin();
    const second = g.begin();
    expect(g.isStale(first)).toBe(true);
    expect(g.isStale(second)).toBe(false);
  });

  it("代际单调递增", () => {
    const g = new ReseedGate();
    expect([g.begin(), g.begin(), g.begin()]).toEqual([1, 2, 3]);
  });
});
