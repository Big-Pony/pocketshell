import { test, expect } from "bun:test";
import { formatDiagReport, DIAG_PREFIX } from "./diag-report";

const at = () => Date.parse("2026-08-01T10:00:00.000Z");

function parse(line: string) {
  expect(line.startsWith(DIAG_PREFIX + " ")).toBe(true);
  return JSON.parse(line.slice(DIAG_PREFIX.length + 1));
}

test("keeps the atlas fields that identify the bug", () => {
  const o = parse(formatDiagReport({
    tag: "claude-1",
    kind: "atlas",
    hasRenderer: true,
    pages: 2,
    pageVersions: [7, 3],
    textureVersions: [7, 3],
    pagesBlank: [true, false],
    pageLayoutVersion: 4,
  }, at));
  expect(o.ts).toBe("2026-08-01T10:00:00.000Z");
  expect(o.tag).toBe("claude-1");
  expect(o.kind).toBe("atlas");
  expect(o.hasRenderer).toBe(true);
  expect(o.pages).toBe(2);
  expect(o.pageVersions).toEqual([7, 3]);
  expect(o.textureVersions).toEqual([7, 3]);
  expect(o.pagesBlank).toEqual([true, false]);
  expect(o.pageLayoutVersion).toBe(4);
});

// pagesBlank alone is ambiguous — a never-used page is blank too. These two are
// what tell "the pixels vanished" apart from "nothing was ever drawn", so a
// whitelist that drops them turns every report back into a guess.
test("keeps the fields that disambiguate a blank page", () => {
  const o = parse(formatDiagReport({
    tag: "t", kind: "atlas",
    pagesBlank: [true, true],
    pageGlyphs: [0, 812],
    pagesUsed: [false, true],
  }, at));
  expect(o.pageGlyphs).toEqual([0, 812]);
  expect(o.pagesUsed).toEqual([false, true]);
});

test("emits exactly one line so one report cannot forge another", () => {
  const line = formatDiagReport({ tag: "a\nb\r\nc", kind: "atlas", error: "x\ny" }, at);
  expect(line.includes("\n")).toBe(false);
  expect(line.includes("\r")).toBe(false);
});

// The whole point of a whitelist: a compromised or buggy client must not be
// able to write terminal contents (or anything else it chooses) into a log the
// user may later paste into a public issue.
test("drops every field that is not on the whitelist", () => {
  const o = parse(formatDiagReport({
    tag: "t", kind: "atlas",
    // things a client might send that we must never persist
    buffer: "sk-live-abcdef",
    cwd: "/Users/someone/secret-project",
    env: { TOKEN: "x" },
  }, at));
  expect(o.buffer).toBeUndefined();
  expect(o.cwd).toBeUndefined();
  expect(o.env).toBeUndefined();
});

test("rejects non-numeric and non-boolean array members instead of echoing them", () => {
  const o = parse(formatDiagReport({
    tag: "t", kind: "atlas",
    pageVersions: [1, "leak", null, 2],
    pagesBlank: [true, "leak", 1],
  }, at));
  expect(o.pageVersions).toEqual([1, 0, 0, 2]);
  expect(o.pagesBlank).toEqual([true, false, false]);
});

test("caps unbounded input so a client cannot flood the log", () => {
  const o = parse(formatDiagReport({
    tag: "x".repeat(500),
    kind: "atlas",
    pageVersions: Array.from({ length: 500 }, (_, i) => i),
    error: "e".repeat(5000),
  }, at));
  expect(o.tag.length).toBeLessThanOrEqual(64);
  expect(o.pageVersions.length).toBeLessThanOrEqual(64);
  expect(o.error.length).toBeLessThanOrEqual(200);
});

test("survives junk input rather than throwing into the rpc handler", () => {
  for (const junk of [undefined, null, 42, "str", [], { tag: {} }]) {
    const line = formatDiagReport(junk as unknown, at);
    expect(line.startsWith(DIAG_PREFIX)).toBe(true);
    expect(() => parse(line)).not.toThrow();
  }
});

test("marks an unknown kind rather than trusting the client's label", () => {
  const o = parse(formatDiagReport({ tag: "t", kind: "whatever" }, at));
  expect(o.kind).toBe("unknown");
});
