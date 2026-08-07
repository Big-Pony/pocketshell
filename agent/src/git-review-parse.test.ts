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

import { splitDiffByFile, synthAddedHunk } from "./git-review-parse";

test("splitDiffByFile 按 diff --git 头拆分，路径取 b/ 侧", () => {
  const out = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "index 111..222 100644",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -12,3 +12,4 @@ fn()",
    " ctx line",
    "-old line",
    "+new line",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  const m = splitDiffByFile(out);
  expect([...m.keys()]).toEqual(["src/auth.ts", "b.ts"]);
  expect(m.get("src/auth.ts")![0].header).toBe("@@ -12,3 +12,4 @@ fn()");
  expect(m.get("src/auth.ts")![0].lines).toEqual([
    { kind: "ctx", text: "ctx line" },
    { kind: "del", text: "old line" },
    { kind: "add", text: "new line" },
  ]);
});

test("splitDiffByFile 丢弃 hunk 之前的文件头行（不混进正文）", () => {
  const out = [
    "diff --git a/a.ts b/a.ts",
    "new file mode 100644",
    "index 000..111",
    "--- /dev/null",
    "+++ b/a.ts",
    "@@ -0,0 +1 @@",
    "+hello",
  ].join("\n");
  const hunks = splitDiffByFile(out).get("a.ts")!;
  expect(hunks).toHaveLength(1);
  expect(hunks[0].lines).toEqual([{ kind: "add", text: "hello" }]);
});

test("splitDiffByFile 处理含空格的路径", () => {
  const out = 'diff --git a/my file.ts b/my file.ts\n--- a/my file.ts\n+++ b/my file.ts\n@@ -1 +1 @@\n+x\n';
  expect([...splitDiffByFile(out).keys()]).toEqual(["my file.ts"]);
});

test("splitDiffByFile 对空输入回空 Map", () => {
  expect(splitDiffByFile("").size).toBe(0);
});

test("synthAddedHunk 把文件内容合成单个全 + 的 hunk", () => {
  const r = synthAddedHunk("line1\nline2\nline3\n", 1500);
  expect(r.add).toBe(3);
  expect(r.truncated).toBe(false);
  expect(r.hunks).toHaveLength(1);
  expect(r.hunks[0].header).toBe("@@ -0,0 +1,3 @@");
  expect(r.hunks[0].lines).toEqual([
    { kind: "add", text: "line1" },
    { kind: "add", text: "line2" },
    { kind: "add", text: "line3" },
  ]);
});

test("synthAddedHunk 超过 cap 时截断并标记", () => {
  const content = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
  const r = synthAddedHunk(content, 10);
  expect(r.hunks[0].lines).toHaveLength(10);
  expect(r.truncated).toBe(true);
  expect(r.add).toBe(50); // add 是真实行数，不是截断后的
});

test("synthAddedHunk 对空文件回空 hunks", () => {
  expect(synthAddedHunk("", 1500).hunks).toEqual([]);
  expect(synthAddedHunk("\n", 1500).add).toBe(1);
});
