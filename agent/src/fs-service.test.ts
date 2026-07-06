import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync as statS, readFileSync as rfSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsTree, fsRead, langForExt, fsDiff, fsOp, fsUploadCheck, fsResolveName, MAX_TRANSFER_BYTES, fsUploadChunk } from "./fs-service";
import { runGit, isRepo } from "./git-service";

function tmp() { return mkdtempSync(join(tmpdir(), "ps-fs-")); }

test("fsTree lists one level, dirs before files, sorted", () => {
  const d = tmp();
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "b.txt"), "b");
  writeFileSync(join(d, "a.txt"), "a");
  const r = fsTree(d);
  expect(r.nodes.map((n) => n.name)).toEqual(["src", "a.txt", "b.txt"]);
  expect(r.nodes[0].type).toBe("dir");
  rmSync(d, { recursive: true, force: true });
});

test("fsTree marks hasChildren for non-empty dir only", () => {
  const d = tmp();
  mkdirSync(join(d, "full")); writeFileSync(join(d, "full", "x"), "x");
  mkdirSync(join(d, "empty"));
  const r = fsTree(d);
  const full = r.nodes.find((n) => n.name === "full")!;
  const empty = r.nodes.find((n) => n.name === "empty")!;
  expect(full.hasChildren).toBe(true);
  expect(empty.hasChildren).toBeFalsy();
  rmSync(d, { recursive: true, force: true });
});

test("fsTree truncates beyond maxNodes", () => {
  const d = tmp();
  for (let i = 0; i < 10; i++) writeFileSync(join(d, `f${i}.txt`), "x");
  const r = fsTree(d, { maxNodes: 5 });
  expect(r.nodes.length).toBe(5);
  expect(r.truncated).toBe(true);
  rmSync(d, { recursive: true, force: true });
});

test("fsTree throws on missing path", () => {
  expect(() => fsTree("/no/such/dir/xyz")).toThrow();
});

test("fsRead returns content + lang for a text file", () => {
  const d = tmp();
  writeFileSync(join(d, "a.ts"), "const x = 1\n");
  const r = fsRead(join(d, "a.ts"));
  expect(r.content).toBe("const x = 1\n");
  expect(r.lang).toBe("typescript");
  expect(r.truncated).toBeFalsy();
  expect(r.binary).toBeFalsy();
  rmSync(d, { recursive: true, force: true });
});

test("fsRead flags binary (NUL byte) with empty content", () => {
  const d = tmp();
  writeFileSync(join(d, "bin"), Buffer.from([0x41, 0x00, 0x42]));
  const r = fsRead(join(d, "bin"));
  expect(r.binary).toBe(true);
  expect(r.content).toBe("");
  rmSync(d, { recursive: true, force: true });
});

test("fsRead truncates beyond maxLines", () => {
  const d = tmp();
  writeFileSync(join(d, "big.txt"), Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
  const r = fsRead(join(d, "big.txt"), { maxLines: 5 });
  expect(r.truncated).toBe(true);
  expect(r.content.split("\n").length).toBeLessThanOrEqual(5);
  rmSync(d, { recursive: true, force: true });
});

test("langForExt maps known + unknown extensions", () => {
  expect(langForExt("x.py")).toBe("python");
  expect(langForExt("x.unknownext")).toBe("plaintext");
});

// P1b: diff + git marks
function gitRepo(d: string) {
  runGit(d, ["init", "-q"]);
  runGit(d, ["config", "user.email", "t@t"]);
  runGit(d, ["config", "user.name", "T"]);
}

test("fsDiff parses working-tree hunks", () => {
  const d = tmp();
  gitRepo(d);
  writeFileSync(join(d, "a.txt"), "one\ntwo\nthree\n");
  runGit(d, ["add", "."]); runGit(d, ["commit", "-q", "-m", "init"]);
  writeFileSync(join(d, "a.txt"), "one\nTWO\nthree\n"); // modify line 2
  const r = fsDiff(join(d, "a.txt"), d);
  expect(r.hunks.length).toBeGreaterThan(0);
  const kinds = r.hunks[0].lines.map((l) => l.kind);
  expect(kinds).toContain("add");
  expect(kinds).toContain("del");
  rmSync(d, { recursive: true, force: true });
});

test("fsDiff returns empty hunks when unchanged", () => {
  const d = tmp();
  gitRepo(d);
  writeFileSync(join(d, "a.txt"), "x\n"); runGit(d, ["add", "."]); runGit(d, ["commit", "-q", "-m", "i"]);
  const r = fsDiff(join(d, "a.txt"), d);
  expect(r.hunks).toEqual([]);
  rmSync(d, { recursive: true, force: true });
});

test("fsTree inlines git marks for tracked/untracked entries", () => {
  const d = tmp();
  gitRepo(d);
  writeFileSync(join(d, "tracked.txt"), "one\n");
  runGit(d, ["add", "."]); runGit(d, ["commit", "-q", "-m", "init"]);
  writeFileSync(join(d, "tracked.txt"), "one\ntwo\n"); // modified
  writeFileSync(join(d, "fresh.txt"), "n");            // untracked
  const r = fsTree(d);
  const byName = Object.fromEntries(r.nodes.map((n) => [n.name, n.git]));
  expect(byName["tracked.txt"]).toBe("M");
  expect(byName["fresh.txt"]).toBe("?");
  rmSync(d, { recursive: true, force: true });
});

test("fsTree leaves git undefined outside a repo", () => {
  const d = tmp();
  writeFileSync(join(d, "a.txt"), "x");
  const r = fsTree(d);
  expect(r.nodes[0].git).toBeUndefined();
  rmSync(d, { recursive: true, force: true });
});

// P1c: fsOp
test("fsOp rename moves a file", () => {
  const d = tmp();
  writeFileSync(join(d, "old.txt"), "x");
  fsOp("rename", join(d, "old.txt"), join(d, "new.txt"));
  expect(existsSync(join(d, "new.txt"))).toBe(true);
  expect(existsSync(join(d, "old.txt"))).toBe(false);
  rmSync(d, { recursive: true, force: true });
});

test("fsOp delete removes a file and a dir", () => {
  const d = tmp();
  writeFileSync(join(d, "f.txt"), "x");
  mkdirSync(join(d, "sub")); writeFileSync(join(d, "sub", "g"), "y");
  fsOp("delete", join(d, "f.txt"));
  fsOp("delete", join(d, "sub"));
  expect(existsSync(join(d, "f.txt"))).toBe(false);
  expect(existsSync(join(d, "sub"))).toBe(false);
  rmSync(d, { recursive: true, force: true });
});

test("fsOp mkdir creates a dir when parent exists", () => {
  const d = tmp();
  fsOp("mkdir", join(d, "made"));
  expect(statS(join(d, "made")).isDirectory()).toBe(true);
  rmSync(d, { recursive: true, force: true });
});

test("fsOp mkdir throws when parent missing", () => {
  const d = tmp();
  expect(() => fsOp("mkdir", join(d, "no", "deep"))).toThrow();
  rmSync(d, { recursive: true, force: true });
});

test("fsUploadCheck returns only existing names", () => {
  const d = tmp();
  writeFileSync(join(d, "a.txt"), "x");
  const r = fsUploadCheck(d, ["a.txt", "b.txt"]);
  expect(r.conflicts).toEqual(["a.txt"]);
  rmSync(d, { recursive: true, force: true });
});

test("fsResolveName returns name unchanged when free", () => {
  const d = tmp();
  expect(fsResolveName(d, "a.txt").name).toBe("a.txt");
  rmSync(d, { recursive: true, force: true });
});

test("fsResolveName suffixes (1),(2) on collision, keeping extension", () => {
  const d = tmp();
  writeFileSync(join(d, "a.txt"), "x");
  writeFileSync(join(d, "a(1).txt"), "x");
  expect(fsResolveName(d, "a.txt").name).toBe("a(2).txt");
  rmSync(d, { recursive: true, force: true });
});

test("fsResolveName handles no-extension names", () => {
  const d = tmp();
  writeFileSync(join(d, "README"), "x");
  expect(fsResolveName(d, "README").name).toBe("README(1)");
  rmSync(d, { recursive: true, force: true });
});

test("fsUploadChunk streams via temp part then copies to destPath on last", () => {
  const d = tmp();
  const tmpDir = join(d, "tmp"); mkdirSync(tmpDir);
  const dest = join(d, "out.bin");
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  fsUploadChunk(tmpDir, "u1", b64("hello "), { first: true });
  const r = fsUploadChunk(tmpDir, "u1", b64("world"), { last: true, destPath: dest });
  expect(r.written).toBe(11);
  expect(rfSync(dest).toString()).toBe("hello world");
  // temp part removed after copy
  expect(existsSync(join(tmpDir, "psupload-u1.part"))).toBe(false);
  rmSync(d, { recursive: true, force: true });
});

test("fsUploadChunk overwrites an existing dest file", () => {
  const d = tmp();
  const tmpDir = join(d, "tmp"); mkdirSync(tmpDir);
  const dest = join(d, "out.bin"); writeFileSync(dest, "OLD-LONG-CONTENT");
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  fsUploadChunk(tmpDir, "u2", b64("new"), { first: true, last: true, destPath: dest });
  expect(rfSync(dest).toString()).toBe("new");
  rmSync(d, { recursive: true, force: true });
});

test("fsUploadChunk throws and cleans temp when exceeding MAX_TRANSFER_BYTES", () => {
  const d = tmp();
  const tmpDir = join(d, "tmp"); mkdirSync(tmpDir);
  // one byte over the cap, base64-encoded
  const big = Buffer.alloc(MAX_TRANSFER_BYTES + 1).toString("base64");
  expect(() => fsUploadChunk(tmpDir, "u3", big, { first: true })).toThrow();
  expect(existsSync(join(tmpDir, "psupload-u3.part"))).toBe(false);
  rmSync(d, { recursive: true, force: true });
});

test("fsOp rename without target throws", () => {
  const d = tmp();
  writeFileSync(join(d, "a"), "x");
  expect(() => fsOp("rename", join(d, "a"))).toThrow();
  rmSync(d, { recursive: true, force: true });
});
