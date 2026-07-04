import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsTree, fsRead, langForExt } from "./fs-service";

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
