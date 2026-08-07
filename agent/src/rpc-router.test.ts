import { test, expect } from "bun:test";
import { parse } from "./rpc-router";

test("parse.gitReview 解析 worktree 三档", () => {
  expect(parse.gitReview({ cwd: "/p", scope: { kind: "worktree", stage: "staged" } }))
    .toEqual({ cwd: "/p", scope: { kind: "worktree", stage: "staged" } });
});

test("parse.gitReview 缺 stage 时默认 all", () => {
  const r = parse.gitReview({ cwd: "/p", scope: { kind: "worktree" } });
  expect(r.scope).toEqual({ kind: "worktree", stage: "all" });
});

test("parse.gitReview 解析 commit 与 range", () => {
  expect(parse.gitReview({ cwd: "/p", scope: { kind: "commit", hash: "abc" } }).scope)
    .toEqual({ kind: "commit", hash: "abc" });
  expect(parse.gitReview({ cwd: "/p", scope: { kind: "range", base: "main" } }).scope)
    .toEqual({ kind: "range", base: "main" });
});

test("parse.gitReview 对未知 kind 回落到 worktree/all（不 throw）", () => {
  // 线上老客户端 / 手工构造的请求不该让 agent 500，回落到最安全的默认范围
  const r = parse.gitReview({ cwd: "/p", scope: { kind: "bogus" } });
  expect(r.scope).toEqual({ kind: "worktree", stage: "all" });
});
