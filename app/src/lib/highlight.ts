// Lazy syntax highlighting via highlight.js core. Languages are registered on
// demand so the initial bundle stays small; any failure falls back to escaped
// plain text (preview is read-only, so an un-highlighted view is acceptable).
import hljs from "highlight.js/lib/core";

const registered = new Set<string>();

// Map our lang ids to highlight.js dynamic-import module paths.
const LOADERS: Record<string, () => Promise<{ default: any }>> = {
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  css: () => import("highlight.js/lib/languages/css"),
  xml: () => import("highlight.js/lib/languages/xml"),
  bash: () => import("highlight.js/lib/languages/bash"),
  python: () => import("highlight.js/lib/languages/python"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function splitLines(content: string): string[] {
  return content.split("\n");
}

// R4: large-file degradation. Over EITHER threshold the preview skips hljs
// (main-thread highlight of a few hundred KB blocks for hundreds of ms) and
// renders escaped plain text without the per-line gutter.
export const HIGHLIGHT_MAX_BYTES = 200 * 1024;
export const HIGHLIGHT_MAX_LINES = 2000;

// Exact UTF-8 byte length (surrogate pairs count as one 4-byte char).
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 2 : c >= 0xdc00 && c <= 0xdfff ? 2 : 3;
  }
  return n;
}

// Pure decision: byte count OR line count over the cap → degrade to plain text.
export function shouldDeferHighlight(bytes: number, lineCount: number): boolean {
  return bytes > HIGHLIGHT_MAX_BYTES || lineCount > HIGHLIGHT_MAX_LINES;
}

export type HighlightResult = {
  html: string;   // highlighted HTML, or escaped plain text when plain/fallback
  plain: boolean; // true → degraded: render without gutter, show plainLarge hint
};

export async function highlightTo(lang: string, content: string): Promise<HighlightResult> {
  if (shouldDeferHighlight(utf8Bytes(content), splitLines(content).length)) {
    return { html: escapeHtml(content), plain: true };
  }
  const loader = LOADERS[lang];
  if (!loader) return { html: escapeHtml(content), plain: false };
  try {
    if (!registered.has(lang)) {
      const mod = await loader();
      hljs.registerLanguage(lang, mod.default);
      registered.add(lang);
    }
    return { html: hljs.highlight(content, { language: lang }).value, plain: false };
  } catch {
    return { html: escapeHtml(content), plain: false };
  }
}
