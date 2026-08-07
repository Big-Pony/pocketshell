import { test, expect } from "vitest";
import { orderBranches, visibleBranches, BRANCH_LIMIT } from "./branch-list";

test("当前分支置顶，其余保持 git 返回的原顺序", () => {
  expect(orderBranches("dev", ["feat-a", "dev", "main", "zz"]))
    .toEqual(["dev", "feat-a", "main", "zz"]);
});

test("当前分支已在首位时顺序不变", () => {
  expect(orderBranches("main", ["main", "dev"])).toEqual(["main", "dev"]);
});

test("当前分支不在列表里时原样返回（detached HEAD 等）", () => {
  expect(orderBranches("HEAD", ["main", "dev"])).toEqual(["main", "dev"]);
});

test("current 为空串时原样返回", () => {
  expect(orderBranches("", ["main", "dev"])).toEqual(["main", "dev"]);
});

test("空列表安全", () => {
  expect(orderBranches("main", [])).toEqual([]);
});

test("默认上限是 5", () => {
  expect(BRANCH_LIMIT).toBe(5);
});

test("折叠态只取前 5 个", () => {
  const all = ["a", "b", "c", "d", "e", "f", "g"];
  expect(visibleBranches(all, false)).toEqual(["a", "b", "c", "d", "e"]);
});

test("展开态返回全部", () => {
  const all = ["a", "b", "c", "d", "e", "f", "g"];
  expect(visibleBranches(all, true)).toEqual(all);
});

test("总数恰好等于上限时折叠态也是全部（不该出现「展开 0 个」）", () => {
  const all = ["a", "b", "c", "d", "e"];
  expect(visibleBranches(all, false)).toEqual(all);
});

test("上限可覆盖", () => {
  expect(visibleBranches(["a", "b", "c"], false, 2)).toEqual(["a", "b"]);
});
