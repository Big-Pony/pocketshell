import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, isRepo, gitLog, gitBranches, gitStatus, mapStatusChar } from "./git-service";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "ps-git-"));
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

test("isRepo true inside repo, false outside", () => {
  const d = repo();
  expect(isRepo(d)).toBe(true);
  const plain = mkdtempSync(join(tmpdir(), "ps-plain-"));
  expect(isRepo(plain)).toBe(false);
  rmSync(d, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true });
});

test("gitLog returns commits newest-first with numstat", () => {
  const d = repo();
  commit(d, "a.txt", "one\n", "first");
  commit(d, "a.txt", "one\ntwo\n", "second");
  const r = gitLog(d, 10);
  expect(r.commits.length).toBe(2);
  expect(r.commits[0].msg).toBe("second");
  expect(r.commits[0].files[0]).toMatchObject({ path: "a.txt", add: 1, del: 0 });
  rmSync(d, { recursive: true, force: true });
});

test("gitLog query filters by grep", () => {
  const d = repo();
  commit(d, "a.txt", "x", "alpha");
  commit(d, "b.txt", "y", "beta");
  const r = gitLog(d, 10, "alpha");
  expect(r.commits.map((c) => c.msg)).toEqual(["alpha"]);
  rmSync(d, { recursive: true, force: true });
});

test("gitLog throws on non-repo", () => {
  const plain = mkdtempSync(join(tmpdir(), "ps-plain2-"));
  expect(() => gitLog(plain, 10)).toThrow();
  rmSync(plain, { recursive: true, force: true });
});

test("mapStatusChar collapses to M/A/D/?", () => {
  expect(mapStatusChar("??")).toBe("?");
  expect(mapStatusChar(" M")).toBe("M");
  expect(mapStatusChar("A ")).toBe("A");
  expect(mapStatusChar(" D")).toBe("D");
  expect(mapStatusChar("R ")).toBe("?");
});

test("gitBranches reports current + list", () => {
  const d = repo();
  commit(d, "a.txt", "x", "init");
  runGit(d, ["branch", "feature"]);
  const r = gitBranches(d);
  expect(r.branches).toContain("feature");
  expect(r.current.length).toBeGreaterThan(0);
  rmSync(d, { recursive: true, force: true });
});

test("gitStatus lists working-tree changes", () => {
  const d = repo();
  commit(d, "a.txt", "one\n", "init");
  writeFileSync(join(d, "a.txt"), "one\ntwo\n"); // modify tracked
  writeFileSync(join(d, "new.txt"), "n");        // untracked
  const r = gitStatus(d);
  const byPath = Object.fromEntries(r.files.map((f) => [f.path, f.status]));
  expect(byPath["a.txt"]).toBe("M");
  expect(byPath["new.txt"]).toBe("?");
  rmSync(d, { recursive: true, force: true });
});
