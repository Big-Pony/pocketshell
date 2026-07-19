<script lang="ts">
  import { tick } from "svelte";
  import MarkdownIt from "markdown-it";
  import DOMPurify from "dompurify";
  import { highlightTo } from "../lib/highlight";
  import { resolveMdImageSrc } from "../lib/preview";

  let { source, mdFileDir, buildImageUrl, onFail }: {
    source: string; mdFileDir: string;
    buildImageUrl: (relToDir: string) => Promise<string>;
    onFail: () => void;
  } = $props();

  let html = $state("");
  let hostEl = $state<HTMLDivElement>();

  // html:false blocks raw HTML tags entirely; DOMPurify is the second layer.
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

  // Highlight code blocks + swap local <img> to token URLs after the HTML lands.
  async function enhance() {
    if (!hostEl) return;
    for (const el of hostEl.querySelectorAll("pre code")) {
      const cls = (el.getAttribute("class") ?? "").match(/language-(\w+)/);
      const res = await highlightTo(cls?.[1] ?? "plaintext", el.textContent ?? "");
      if (!res.plain) el.innerHTML = res.html;
    }
    for (const img of hostEl.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      const r = resolveMdImageSrc(mdFileDir, src);
      if (r) { try { img.setAttribute("src", await buildImageUrl(r.relToDir)); } catch {} }
    }
  }

  // Render then enhance in one flow: sanitize → {@html} commits after tick →
  // highlight code blocks + rewrite local images against the live DOM.
  $effect(() => {
    const src = source; // track the prop
    (async () => {
      try {
        const dirty = md.render(src);
        html = DOMPurify.sanitize(dirty, { ADD_ATTR: ["target"] });
      } catch { onFail(); return; }
      await tick();
      await enhance();
    })();
  });
</script>

<div class="md-body" bind:this={hostEl}>{@html html}</div>

<style>
  /* 富文本排版走语义令牌，深浅两主题通用 */
  .md-body { padding: 12px 14px; color: var(--text); font-size: 0.82rem; line-height: 1.6; overflow-wrap: anywhere; }
  .md-body :global(h1), .md-body :global(h2), .md-body :global(h3) { color: var(--text); line-height: 1.3; margin: 0.8em 0 0.4em; }
  .md-body :global(a) { color: var(--accent); }
  .md-body :global(code) { background: var(--code-bg); color: var(--code-fg); padding: 1px 4px; border-radius: 4px; font-size: 0.9em; }
  .md-body :global(pre) { background: var(--code-bg); color: var(--code-fg); padding: 10px; border-radius: var(--radius-md, 8px); overflow: auto; }
  .md-body :global(pre code) { background: none; padding: 0; }
  .md-body :global(blockquote) { border-left: 3px solid var(--line); color: var(--dim); margin: 0.6em 0; padding: 0 0 0 12px; }
  .md-body :global(table) { border-collapse: collapse; }
  .md-body :global(th), .md-body :global(td) { border: 1px solid var(--line); padding: 4px 8px; }
  .md-body :global(img) { max-width: 100%; height: auto; }
</style>
