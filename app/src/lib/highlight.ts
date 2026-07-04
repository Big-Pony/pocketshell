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

export async function highlightTo(lang: string, content: string): Promise<string> {
  const loader = LOADERS[lang];
  if (!loader) return escapeHtml(content);
  try {
    if (!registered.has(lang)) {
      const mod = await loader();
      hljs.registerLanguage(lang, mod.default);
      registered.add(lang);
    }
    return hljs.highlight(content, { language: lang }).value;
  } catch {
    return escapeHtml(content);
  }
}
