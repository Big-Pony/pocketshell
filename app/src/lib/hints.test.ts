import { test, expect } from "vitest";
import {
  isSlashHint, splitPools, filterAgainstBuiltins, parseHintImport, buildHintPrompt, HINT_MAX_LEN,
} from "./hints";

// ---- 归类 ----
test("isSlashHint 按开头字符判定", () => {
  expect(isSlashHint("/clear")).toBe(true);
  expect(isSlashHint("git status")).toBe(false);
});

test("splitPools 把条目分到两个池", () => {
  expect(splitPools(["git status", "/clear", "ls"])).toEqual({
    shell: ["git status", "ls"],
    slash: ["/clear"],
  });
});

// ---- 内置去重 ----
test("filterAgainstBuiltins 丢掉命中内置的条目并计数", () => {
  const r = filterAgainstBuiltins(["git status", "my-cmd"], new Set(["git status"]));
  expect(r.ok).toEqual(["my-cmd"]);
  expect(r.builtinHits).toBe(1);
});

test("filterAgainstBuiltins 精确匹配：尾空格不同即不算重复", () => {
  // 内置 "git add " 待补参数，用户的 "git add " 才算重复；"git add" 是另一条
  const r = filterAgainstBuiltins(["git add"], new Set(["git add "]));
  expect(r.ok).toEqual(["git add"]);
  expect(r.builtinHits).toBe(0);
});

test("filterAgainstBuiltins 无命中时原样返回", () => {
  const r = filterAgainstBuiltins(["a", "b"], new Set(["c"]));
  expect(r.ok).toEqual(["a", "b"]);
  expect(r.builtinHits).toBe(0);
});

// ---- 导入解析 ----
test("parseHintImport 解析纯 JSON 数组", () => {
  const r = parseHintImport('["git status", "npm test"]');
  expect(r.ok).toEqual(["git status", "npm test"]);
  expect(r.error).toBeUndefined();
});

test("parseHintImport 剥掉 markdown 代码围栏", () => {
  const r = parseHintImport('```json\n["a", "b"]\n```');
  expect(r.ok).toEqual(["a", "b"]);
});

test("parseHintImport 回退到按行解析", () => {
  const r = parseHintImport("git status\nnpm test\n");
  expect(r.ok).toEqual(["git status", "npm test"]);
});

test("parseHintImport 按行解析时剥掉列表符号与引号逗号", () => {
  const r = parseHintImport('- "git status",\n* npm test\n');
  expect(r.ok).toEqual(["git status", "npm test"]);
});

test("parseHintImport 丢弃空行", () => {
  expect(parseHintImport("a\n\n\nb").ok).toEqual(["a", "b"]);
});

test("parseHintImport 批内去重并计数", () => {
  const r = parseHintImport('["a", "a", "b"]');
  expect(r.ok).toEqual(["a", "b"]);
  expect(r.skippedDup).toBe(1);
});

test("parseHintImport 丢弃超长条目并计数", () => {
  const long = "x".repeat(HINT_MAX_LEN + 1);
  const r = parseHintImport(JSON.stringify(["ok", long]));
  expect(r.ok).toEqual(["ok"]);
  expect(r.skippedLong).toBe(1);
});

test("parseHintImport 空输入返回 error", () => {
  expect(parseHintImport("   ").error).toBeTruthy();
});

test("parseHintImport JSON 里的非字符串元素被忽略", () => {
  const r = parseHintImport('["ok", 42, null, {"a":1}]');
  expect(r.ok).toEqual(["ok"]);
});

// ---- 提示词 ----
test("buildHintPrompt 含格式要求、内置清单与已有条目", () => {
  const p = buildHintPrompt(["my-cmd"], ["git status"]);
  expect(p).toContain("JSON");
  expect(p).toContain("git status");   // 内置清单
  expect(p).toContain("my-cmd");       // 已有条目
  expect(p).toContain(String(HINT_MAX_LEN));
});

test("buildHintPrompt 已有条目为空时仍可生成", () => {
  expect(buildHintPrompt([], ["git status"]).length).toBeGreaterThan(0);
});
