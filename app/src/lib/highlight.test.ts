import { test, expect } from "vitest";
import {
  splitLines, escapeHtml, highlightTo,
  shouldDeferHighlight, utf8Bytes, HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINES,
} from "./highlight";

test("escapeHtml neutralizes markup", () => {
  expect(escapeHtml(`<script>"a"&b</script>`)).toBe("&lt;script&gt;&quot;a&quot;&amp;b&lt;/script&gt;");
});

test("splitLines splits on newline", () => {
  expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  expect(splitLines("a\n")).toEqual(["a", ""]);
});

test("highlightTo falls back to escaped text for unknown lang", async () => {
  const res = await highlightTo("plaintext", "<x>");
  expect(res.plain).toBe(false);
  expect(res.html).toBe("&lt;x&gt;");
});

test("shouldDeferHighlight gates on bytes OR lines, boundary values stay highlighted", () => {
  expect(shouldDeferHighlight(HIGHLIGHT_MAX_BYTES + 1, 10)).toBe(true);
  expect(shouldDeferHighlight(100, HIGHLIGHT_MAX_LINES + 1)).toBe(true);
  expect(shouldDeferHighlight(HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINES)).toBe(false);
  expect(shouldDeferHighlight(0, 0)).toBe(false);
});

test("utf8Bytes counts ASCII, CJK and surrogate pairs as UTF-8", () => {
  expect(utf8Bytes("abc")).toBe(3);
  expect(utf8Bytes("中文")).toBe(6);
  expect(utf8Bytes("a🙂")).toBe(5); // 1 + 4-byte surrogate pair
});

test("highlightTo degrades to escaped plain text over the byte threshold", async () => {
  const content = "<" + "x".repeat(HIGHLIGHT_MAX_BYTES) + ">";
  const res = await highlightTo("typescript", content);
  expect(res.plain).toBe(true);
  expect(res.html).toBe(escapeHtml(content)); // escaped, not highlighted
  expect(res.html.startsWith("&lt;")).toBe(true);
});

test("highlightTo degrades over the line threshold even for small byte counts", async () => {
  const content = "a\n".repeat(HIGHLIGHT_MAX_LINES) + "end";
  const res = await highlightTo("typescript", content);
  expect(res.plain).toBe(true);
  expect(res.html).toBe(escapeHtml(content));
});

test("highlightTo still highlights small files (plain=false)", async () => {
  const res = await highlightTo("json", `{"a":1}`);
  expect(res.plain).toBe(false);
  expect(res.html).toContain("hljs"); // real highlight.js spans
});
