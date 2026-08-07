import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git-service";
import { diffArgs, inferBaseline, hasHead } from "./git-review";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "ps-rev-"));
  runGit(d, ["init", "-q"]);
  runGit(d, ["config", "user.email", "t@t"]);
  runGit(d, ["config", "user.name", "T"]);
  return d;
}
function commit(d: string, file: string, body: string, msg: string) {
  writeFileSync(join(d, file), body);
  runGit(d, ["add", "."]);
  runGit(d, ["commit", "-q", "-m", msg]);
}

test("diffArgs: worktree 三档各自映射", () => {
  expect(diffArgs({ kind: "worktree", stage: "all" }, true)!.numstat)
    .toEqual(["diff", "HEAD", "--numstat", "--find-renames"]);
  expect(diffArgs({ kind: "worktree", stage: "staged" }, true)!.body)
    .toEqual(["diff", "--cached", "--find-renames"]);
  expect(diffArgs({ kind: "worktree", stage: "unstaged" }, true)!.body)
    .toEqual(["diff", "--find-renames"]);
});

test("diffArgs: commit 用 show 且抹掉 format 头", () => {
  const a = diffArgs({ kind: "commit", hash: "abc123" }, true)!;
  expect(a.numstat).toEqual(["show", "abc123", "--numstat", "--format=", "--find-renames"]);
  expect(a.body).toEqual(["show", "abc123", "--format=", "--find-renames"]);
});

test("diffArgs: range 用三点语义（相对分叉点）", () => {
  const a = diffArgs({ kind: "range", base: "main" }, true)!;
  expect(a.numstat).toEqual(["diff", "main...HEAD", "--numstat", "--find-renames"]);
  expect(a.body).toEqual(["diff", "main...HEAD", "--find-renames"]);
});

test("diffArgs: 空仓库时 all/staged 降级为 --cached，unstaged 回 null", () => {
  expect(diffArgs({ kind: "worktree", stage: "all" }, false)!.body)
    .toEqual(["diff", "--cached", "--find-renames"]);
  expect(diffArgs({ kind: "worktree", stage: "staged" }, false)!.body)
    .toEqual(["diff", "--cached", "--find-renames"]);
  // 没有 HEAD 就没有"已提交"这个参照，未暂存档无意义
  expect(diffArgs({ kind: "worktree", stage: "unstaged" }, false)).toBeNull();
});

test("hasHead: 空仓库 false，有提交后 true", () => {
  const d = repo();
  expect(hasHead(d)).toBe(false);
  commit(d, "a.txt", "x\n", "init");
  expect(hasHead(d)).toBe(true);
  rmSync(d, { recursive: true, force: true });
});

test("inferBaseline: 优先 main", () => {
  const d = repo();
  commit(d, "a.txt", "x\n", "init");
  runGit(d, ["branch", "-M", "main"]);
  runGit(d, ["branch", "develop"]);
  expect(inferBaseline(d)).toBe("main");
  rmSync(d, { recursive: true, force: true });
});

test("inferBaseline: 无 main 时退到 master", () => {
  const d = repo();
  commit(d, "a.txt", "x\n", "init");
  runGit(d, ["branch", "-M", "master"]);
  expect(inferBaseline(d)).toBe("master");
  rmSync(d, { recursive: true, force: true });
});

test("inferBaseline: 无 main/master/develop 时 throw no_baseline", () => {
  const d = repo();
  commit(d, "a.txt", "x\n", "init");
  runGit(d, ["branch", "-M", "weird-trunk"]);
  expect(() => inferBaseline(d)).toThrow(/no_baseline/);
  rmSync(d, { recursive: true, force: true });
});
