import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
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

/**
 * 数一段代码里 spawn 了几次 git。P1 要守的性质是"与规模无关"，
 * 所以断言的是两次调用次数相等，而不是某个魔法数字。
 */
function countSpawns(fn: () => unknown): number {
  const orig = Bun.spawnSync;
  let n = 0;
  (Bun as any).spawnSync = (...args: unknown[]) => { n++; return (orig as any)(...args); };
  try { fn(); } finally { (Bun as any).spawnSync = orig; }
  return n;
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

import { gitReview } from "./git-review";

test("gitReview worktree/all 同时含已暂存与未暂存的改动", () => {
  const d = repo();
  commit(d, "a.txt", "one\n", "init");
  writeFileSync(join(d, "a.txt"), "one\ntwo\n");
  runGit(d, ["add", "a.txt"]);                       // 暂存第一处
  writeFileSync(join(d, "a.txt"), "one\ntwo\nthree\n"); // 再改一处，未暂存
  const r = gitReview(d, { kind: "worktree", stage: "all" });
  const f = r.files.find((x) => x.path === "a.txt")!;
  expect(f.add).toBe(2);              // 两处都算进来——这正是修复的核心缺陷
  expect(f.staged).toBe("partial");
  rmSync(d, { recursive: true, force: true });
});

test("gitReview 未跟踪文件带正文（全 + 单 hunk）", () => {
  const d = repo();
  commit(d, "a.txt", "x\n", "init");
  writeFileSync(join(d, "new.ts"), "alpha\nbeta\n");
  const r = gitReview(d, { kind: "worktree", stage: "all" });
  const f = r.files.find((x) => x.path === "new.ts")!;
  expect(f.status).toBe("?");
  expect(f.add).toBe(2);
  expect(f.hunks![0].lines).toEqual([
    { kind: "add", text: "alpha" },
    { kind: "add", text: "beta" },
  ]);
  rmSync(d, { recursive: true, force: true });
});

test("gitReview 未跟踪目录只出一个条目、不展开、不读内容", () => {
  const d = repo();
  commit(d, "a.txt", "x\n", "init");
  const sub = join(d, "newdir");
  mkdirSync(sub);
  writeFileSync(join(sub, "f1.ts"), "x\n");
  writeFileSync(join(sub, "f2.ts"), "y\n");
  const r = gitReview(d, { kind: "worktree", stage: "all" });
  const dirs = r.files.filter((x) => x.isDir);
  expect(dirs).toHaveLength(1);
  expect(dirs[0].path).toBe("newdir/");
  expect(dirs[0].hunks).toBeUndefined();
  expect(r.files.some((x) => x.path.includes("f1.ts"))).toBe(false);
  rmSync(d, { recursive: true, force: true });
});

test("gitReview staged 档不含未跟踪文件", () => {
  const d = repo();
  commit(d, "a.txt", "x\n", "init");
  writeFileSync(join(d, "untracked.ts"), "u\n");
  const r = gitReview(d, { kind: "worktree", stage: "staged" });
  expect(r.files.some((f) => f.path === "untracked.ts")).toBe(false);
  rmSync(d, { recursive: true, force: true });
});

test("gitReview commit 范围回该提交的完整 diff", () => {
  const d = repo();
  commit(d, "a.txt", "one\n", "first");
  commit(d, "a.txt", "one\ntwo\n", "second");
  const hash = runGit(d, ["rev-parse", "HEAD"]).stdout.trim();
  const r = gitReview(d, { kind: "commit", hash });
  expect(r.files[0].path).toBe("a.txt");
  expect(r.files[0].hunks!.length).toBeGreaterThan(0);
  expect(r.title).toContain("second");
  rmSync(d, { recursive: true, force: true });
});

test("gitReview range 只含本分支改动，不含基线后续推进", () => {
  const d = repo();
  commit(d, "a.txt", "one\n", "init");
  runGit(d, ["branch", "-M", "main"]);
  runGit(d, ["checkout", "-q", "-b", "feat"]);
  commit(d, "feat.ts", "mine\n", "my work");
  runGit(d, ["checkout", "-q", "main"]);
  commit(d, "other.ts", "theirs\n", "someone else");  // 基线往前走了
  runGit(d, ["checkout", "-q", "feat"]);
  const r = gitReview(d, { kind: "range", base: "main" });
  const paths = r.files.map((f) => f.path);
  expect(paths).toContain("feat.ts");
  expect(paths).not.toContain("other.ts");   // 三点语义的关键
  rmSync(d, { recursive: true, force: true });
});

test("gitReview 超 cap 的文件降级为 oversize 且不含正文", () => {
  const d = repo();
  commit(d, "a.txt", "x\n", "init");
  const huge = Array.from({ length: 3000 }, (_, i) => `l${i}`).join("\n") + "\n";
  writeFileSync(join(d, "huge.lock"), huge);
  writeFileSync(join(d, "small.ts"), "s\n");
  const r = gitReview(d, { kind: "worktree", stage: "all" });
  const h = r.files.find((f) => f.path === "huge.lock")!;
  const s = r.files.find((f) => f.path === "small.ts")!;
  expect(h.oversize).toBe(true);
  expect(h.hunks).toBeUndefined();
  expect(h.add).toBe(3000);        // 数字仍要说实话
  expect(s.hunks).toBeDefined();   // 小文件不受牵连
  expect(r.truncated).toBe(true);
  rmSync(d, { recursive: true, force: true });
});

test("gitReview 二进制文件标 binary、不读正文", () => {
  const d = repo();
  commit(d, "a.txt", "x\n", "init");
  writeFileSync(join(d, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  const r = gitReview(d, { kind: "worktree", stage: "all" });
  const f = r.files.find((x) => x.path === "blob.bin")!;
  expect(f.binary).toBe(true);
  expect(f.hunks).toBeUndefined();
  rmSync(d, { recursive: true, force: true });
});

test("gitReview 删除的文件不传正文", () => {
  const d = repo();
  commit(d, "gone.ts", "a\nb\nc\n", "init");
  rmSync(join(d, "gone.ts"));
  const r = gitReview(d, { kind: "worktree", stage: "all" });
  const f = r.files.find((x) => x.path === "gone.ts")!;
  expect(f.status).toBe("D");
  expect(f.hunks).toBeUndefined();
  rmSync(d, { recursive: true, force: true });
});

test("gitReview 回三档计数供 UI 显示", () => {
  const d = repo();
  commit(d, "a.txt", "x\n", "init");
  writeFileSync(join(d, "a.txt"), "y\n");
  runGit(d, ["add", "a.txt"]);
  writeFileSync(join(d, "b.txt"), "n\n");   // 未跟踪
  const r = gitReview(d, { kind: "worktree", stage: "all" });
  expect(r.counts!.staged).toBe(1);
  expect(r.counts!.all).toBe(2);
  rmSync(d, { recursive: true, force: true });
});

test("gitReview 空仓库不报错，未跟踪文件照常列出", () => {
  const d = repo();
  writeFileSync(join(d, "first.ts"), "hello\n");
  const r = gitReview(d, { kind: "worktree", stage: "all" });
  expect(r.files.some((f) => f.path === "first.ts")).toBe(true);
  rmSync(d, { recursive: true, force: true });
});

test("gitReview 非仓库 throw not_a_repo", () => {
  const plain = mkdtempSync(join(tmpdir(), "ps-plain3-"));
  expect(() => gitReview(plain, { kind: "worktree", stage: "all" })).toThrow(/not_a_repo/);
  rmSync(plain, { recursive: true, force: true });
});

test("gitReview 坏 hash throw bad_revision", () => {
  const d = repo();
  commit(d, "a.txt", "x\n", "init");
  expect(() => gitReview(d, { kind: "commit", hash: "deadbeef" })).toThrow(/bad_revision/);
  rmSync(d, { recursive: true, force: true });
});

test("P1: spawn 次数与文件数无关", () => {
  const mk = (n: number) => {
    const d = repo();
    commit(d, "seed.txt", "x\n", "init");
    for (let i = 0; i < n; i++) writeFileSync(join(d, `f${i}.ts`), `line${i}\n`);
    return d;
  };
  const d8 = mk(8), d80 = mk(80);
  const c8 = countSpawns(() => gitReview(d8, { kind: "worktree", stage: "all" }));
  const c80 = countSpawns(() => gitReview(d80, { kind: "worktree", stage: "all" }));
  expect(c8).toBe(c80);
  expect(c8).toBeLessThanOrEqual(5);
  rmSync(d8, { recursive: true, force: true });
  rmSync(d80, { recursive: true, force: true });
});
