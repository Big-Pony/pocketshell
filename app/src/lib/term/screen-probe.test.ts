import { describe, expect, it } from "vitest";
import { hashLine, hashViewport, normLine, viewportLines } from "./screen-probe";

// agent/src/screen-diff.ts 的 hashLine 必须与这里逐字一致，否则对拍出来的差异
// 全是假的。这组固定向量是两端的契约：**改动任一侧的哈希实现，两处测试同时红**。
// 期望值由本实现产出并在 agent/src/screen-diff.test.ts 侧以相同输入复核。
describe("哈希与归一（与 agent 侧的跨仓契约）", () => {
  it("固定向量", () => {
    expect(hashLine("")).toBe(2166136261);
    expect(hashLine("a")).toBe(3826002220);
    expect(hashLine("hello")).toBe(1335831723);
  });
  it("去行尾、留行首", () => {
    expect(normLine("  x  ")).toBe("  x");
    expect(hashLine(normLine("x   "))).toBe(hashLine("x"));
    expect(hashLine(normLine("  x"))).not.toBe(hashLine("x"));
  });
});

const mkTerm = (rows: number, lines: (string | null)[], viewportY = 0) => ({
  rows,
  buffer: {
    active: {
      viewportY,
      length: lines.length,
      getLine: (y: number) => {
        const v = lines[y];
        return v === undefined || v === null ? undefined : { translateToString: () => v };
      },
    },
  },
});

describe("viewportLines", () => {
  it("从 viewportY 起取 rows 行", () => {
    const t = mkTerm(3, ["l0", "l1", "l2", "l3", "l4"], 1);
    expect(viewportLines(t)).toEqual(["l1", "l2", "l3"]);
  });

  it("用 viewportY 而非 baseY —— 用户上滚后必须拿屏幕上那一屏", () => {
    // 视口停在顶部，底部还有更多行；取到的必须是顶部三行
    const t = mkTerm(3, ["a", "b", "c", "d", "e", "f"], 0);
    expect(viewportLines(t)).toEqual(["a", "b", "c"]);
  });

  it("越界行补空串，保住行号与视口位置一一对应", () => {
    const t = mkTerm(4, ["l0", "l1"], 0);
    expect(viewportLines(t)).toEqual(["l0", "l1", "", ""]);
  });

  it("getLine 返回 undefined 也补空串而不是塌陷", () => {
    const t = mkTerm(3, ["l0", null, "l2"], 0);
    expect(viewportLines(t)).toEqual(["l0", "", "l2"]);
  });
});

describe("hashViewport", () => {
  it("行数等于 rows", () => {
    expect(hashViewport(mkTerm(5, ["a", "b"], 0))).toHaveLength(5);
  });
  it("行尾空白不影响结果（tmux 会补空格，xterm 不会）", () => {
    const a = hashViewport(mkTerm(2, ["x   ", "y"], 0));
    const b = hashViewport(mkTerm(2, ["x", "y"], 0));
    expect(a).toEqual(b);
  });
  it("内容变了哈希就变", () => {
    const a = hashViewport(mkTerm(2, ["x", "y"], 0));
    const b = hashViewport(mkTerm(2, ["x", "z"], 0));
    expect(a[1]).not.toBe(b[1]);
  });
});
