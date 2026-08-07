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
  expect(m.get("src/auth.ts")!.hunks[0].header).toBe("@@ -12,3 +12,4 @@ fn()");
  expect(m.get("src/auth.ts")!.hunks[0].lines).toEqual([
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
  const hunks = splitDiffByFile(out).get("a.ts")!.hunks;
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

test("splitDiffByFile 从文件头认出 A/D/R/M 四种状态", () => {
  const added = [
    "diff --git a/a.ts b/a.ts",
    "new file mode 100644",
    "index 000..111",
    "--- /dev/null",
    "+++ b/a.ts",
    "@@ -0,0 +1 @@",
    "+hello",
  ].join("\n");
  expect(splitDiffByFile(added).get("a.ts")!.status).toBe("A");

  const deleted = [
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "index 111..000",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
  ].join("\n");
  expect(splitDiffByFile(deleted).get("gone.ts")!.status).toBe("D");

  const renamed = [
    "diff --git a/old.ts b/new.ts",
    "similarity index 92%",
    "rename from old.ts",
    "rename to new.ts",
    "index 111..222 100644",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  expect(splitDiffByFile(renamed).get("new.ts")!.status).toBe("R");

  const modified = [
    "diff --git a/m.ts b/m.ts",
    "index 111..222 100644",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  expect(splitDiffByFile(modified).get("m.ts")!.status).toBe("M");
});

test("splitDiffByFile 不把正文里长得像文件头的行当状态", () => {
  // hunk 内的 ctx/add 行即使文本是 "new file mode 100644" 也不能改写状态
  const out = [
    "diff --git a/m.ts b/m.ts",
    "index 111..222 100644",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -1,2 +1,2 @@",
    " new file mode 100644",
    "-deleted file mode 100644",
    "+rename from x",
  ].join("\n");
  const e = splitDiffByFile(out).get("m.ts")!;
  expect(e.status).toBe("M");
  expect(e.hunks[0].lines).toEqual([
    { kind: "ctx", text: "new file mode 100644" },
    { kind: "del", text: "deleted file mode 100644" },
    { kind: "add", text: "rename from x" },
  ]);
});

test("splitDiffByFile 纯重命名（无内容改动、无 hunk）也认出 R", () => {
  const out = [
    "diff --git a/old.ts b/new.ts",
    "similarity index 100%",
    "rename from old.ts",
    "rename to new.ts",
  ].join("\n");
  const e = splitDiffByFile(out).get("new.ts")!;
  expect(e.status).toBe("R");
  expect(e.hunks).toEqual([]);
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

import { planBudget, FILE_LINE_CAP, TOTAL_LINE_BUDGET } from "./git-review-parse";

test("planBudget 在预算内全部保留", () => {
  const rows = [
    { path: "a.ts", add: 10, del: 5 },
    { path: "b.ts", add: 20, del: 0 },
  ];
  const r = planBudget(rows, 8000, 1500);
  expect(r.keep).toEqual(new Set(["a.ts", "b.ts"]));
  expect(r.truncated).toBe(false);
});

test("planBudget 单文件超 cap 直接降级，不占总预算", () => {
  const rows = [
    { path: "huge.lock", add: 3000, del: 2000 },
    { path: "small.ts", add: 10, del: 2 },
  ];
  const r = planBudget(rows, 8000, 1500);
  expect(r.keep.has("huge.lock")).toBe(false);
  expect(r.keep.has("small.ts")).toBe(true);
  expect(r.truncated).toBe(true);
});

test("planBudget 按体量从小到大装填——小文件优先保住", () => {
  // 总预算 100：若按输入顺序装，big 先吃掉 90，只剩 10 给后面三个；
  // 按体量升序则三个小的（共 30）全保住，big 被挤掉。
  const rows = [
    { path: "big.ts", add: 90, del: 0 },
    { path: "s1.ts", add: 10, del: 0 },
    { path: "s2.ts", add: 10, del: 0 },
    { path: "s3.ts", add: 10, del: 0 },
  ];
  const r = planBudget(rows, 100, 1500);
  expect(r.keep).toEqual(new Set(["s1.ts", "s2.ts", "s3.ts"]));
  expect(r.truncated).toBe(true);
});

test("planBudget 装满即停，后续更大的都降级", () => {
  const rows = [
    { path: "a.ts", add: 40, del: 0 },
    { path: "b.ts", add: 40, del: 0 },
    { path: "c.ts", add: 40, del: 0 },
  ];
  const r = planBudget(rows, 100, 1500);
  expect(r.keep.size).toBe(2);
  expect(r.truncated).toBe(true);
});

test("planBudget 同体量时按路径排序，结果稳定可复现", () => {
  const rows = [
    { path: "z.ts", add: 10, del: 0 },
    { path: "a.ts", add: 10, del: 0 },
  ];
  const r1 = planBudget(rows, 15, 1500);
  const r2 = planBudget([...rows].reverse(), 15, 1500);
  expect(r1.keep).toEqual(new Set(["a.ts"]));
  expect(r2.keep).toEqual(r1.keep); // 输入顺序不影响结果
});

test("planBudget 空清单不报 truncated", () => {
  expect(planBudget([], 8000, 1500)).toEqual({ keep: new Set(), truncated: false });
});

test("阈值常量取 spec 规定的值", () => {
  expect(FILE_LINE_CAP).toBe(1500);
  expect(TOTAL_LINE_BUDGET).toBe(8000);
});
