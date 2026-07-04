import { test, expect } from "vitest";
import { splitLines, escapeHtml, highlightTo } from "./highlight";

test("escapeHtml neutralizes markup", () => {
  expect(escapeHtml(`<script>"a"&b</script>`)).toBe("&lt;script&gt;&quot;a&quot;&amp;b&lt;/script&gt;");
});

test("splitLines splits on newline", () => {
  expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  expect(splitLines("a\n")).toEqual(["a", ""]);
});

test("highlightTo falls back to escaped text for unknown lang", async () => {
  const out = await highlightTo("plaintext", "<x>");
  expect(out).toBe("&lt;x&gt;");
});
