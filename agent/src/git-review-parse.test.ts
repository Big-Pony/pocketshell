import { test, expect } from "bun:test";
import { parseNumstat, parsePorcelain, stagedMark } from "./git-review-parse";

test("parseNumstat 解析常规行", () => {
  const out = "42\t8\tsrc/auth.ts\n55\t0\tsrc/token-store.ts\n";
  expect(parseNumstat(out)).toEqual([
    { path: "src/auth.ts", add: 42, del: 8, binary: false },
    { path: "src/token-store.ts", add: 55, del: 0, binary: false },
  ]);
});

test("parseNumstat 把 '-\t-' 识别为二进制而不是 0", () => {
  const out = "-\t-\tassets/logo.png\n3\t1\ta.ts\n";
  const rows = parseNumstat(out);
  expect(rows[0]).toEqual({ path: "assets/logo.png", add: 0, del: 0, binary: true });
  expect(rows[1].binary).toBe(false);
});

test("parseNumstat 忽略空行与残缺行", () => {
  expect(parseNumstat("\n\n42\t8\ta.ts\n\n")).toHaveLength(1);
  expect(parseNumstat("42\t8\n")).toHaveLength(0); // 缺 path
});

test("parseNumstat 保留重命名箭头形式的新路径", () => {
  // git 在 --find-renames 下回 "old => new" 或带花括号的紧凑形式
  const out = "1\t1\tsrc/{old => new}.ts\n2\t0\ta.ts => b.ts\n";
  const rows = parseNumstat(out);
  expect(rows[0].path).toBe("src/new.ts");
  expect(rows[1].path).toBe("b.ts");
});

test("parsePorcelain 拆出 XY 两字符与路径", () => {
  const out = " M src/auth.ts\nA  src/new.ts\n?? scratch.md\n";
  expect(parsePorcelain(out)).toEqual([
    { path: "src/auth.ts", x: " ", y: "M", isDir: false },
    { path: "src/new.ts", x: "A", y: " ", isDir: false },
    { path: "scratch.md", x: "?", y: "?", isDir: false },
  ]);
});

test("parsePorcelain 标出未跟踪目录（以 / 结尾）", () => {
  const rows = parsePorcelain("?? newdir/\n?? a.ts\n");
  expect(rows[0]).toMatchObject({ path: "newdir/", isDir: true });
  expect(rows[1].isDir).toBe(false);
});

test("stagedMark: X 有内容即已暂存，XY 都有即部分暂存", () => {
  expect(stagedMark("M", " ")).toBe("full");
  expect(stagedMark("A", " ")).toBe("full");
  expect(stagedMark("M", "M")).toBe("partial");
  expect(stagedMark(" ", "M")).toBeUndefined();  // 只在工作区改
  expect(stagedMark("?", "?")).toBeUndefined();  // 未跟踪不算暂存
});
