<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import type { Terminal } from "@xterm/xterm";
  import { prepareRowsClone, readTermFont, ownerClassOf } from "../lib/term-clone";

  // req 7-5 (copy mode): overlay a selectable clone of the terminal's visible
  // rows so a mobile long-press can select text natively (see lib/term-clone.ts).
  let { term, onClose, onCopy }: {
    term: Terminal | undefined;
    onClose: () => void;
    onCopy: (text: string) => void;
  } = $props();

  let holder: HTMLDivElement;
  let empty = $state(false);

  onMount(() => {
    const root = term?.element;
    if (!root) { empty = true; return; }
    // Copy xterm's font metrics so the clone keeps monospace alignment.
    const font = readTermFont(getComputedStyle(root));
    holder.style.fontFamily = font.fontFamily;
    holder.style.fontSize = font.fontSize;
    holder.style.lineHeight = font.lineHeight;
    holder.style.letterSpacing = font.letterSpacing;
    // xterm's colour rules are scoped under its owner class; the clone must carry
    // it or every glyph renders in the default foreground (colours lost).
    const owner = ownerClassOf(root.classList);
    if (owner) holder.classList.add(owner);
    // Clone AFTER the DOM renderer has flushed its rows (double rAF) — otherwise
    // a just-activated terminal may still have empty rows.
    let r1 = 0, r2 = 0;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        const rows = root.querySelector(".xterm-rows") as HTMLElement | null;
        if (!rows) { empty = true; return; }
        holder.appendChild(prepareRowsClone(rows));
        empty = holder.textContent?.trim() === "";
      });
    });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  });

  function selectAll() {
    const r = document.createRange();
    r.selectNodeContents(holder);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }
  function copySel() {
    onCopy(window.getSelection()?.toString() ?? "");
  }
</script>

<div class="cm-overlay">
  <div class="cm-bar">
    <span class="cm-title">{$t('copymode.title')}</span>
    <span class="cm-hint">{$t('copymode.hint')}</span>
    <span class="sp"></span>
    <button class="cm-btn" onclick={selectAll}>{$t('copymode.selectAll')}</button>
    <button class="cm-btn" onclick={copySel}>{$t('copymode.copy')}</button>
    <button class="cm-btn primary" onclick={onClose}>{$t('copymode.done')}</button>
  </div>
  <div class="cm-content">
    <div class="cm-rows" bind:this={holder}></div>
    {#if empty}<div class="cm-empty">{$t('copymode.empty')}</div>{/if}
  </div>
</div>

<style>
  /* 覆盖层盖住终端区。文本区固定深色（--term-*，两套主题一致）；bar 走语义令牌 */
  .cm-overlay {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    background: var(--term-bg);
  }
  .cm-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 40px;
    box-sizing: border-box;
    padding: 4px 8px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    flex: 0 0 auto;
  }
  .cm-title { font-size: 0.76rem; font-weight: 600; color: var(--text); }
  .cm-hint { font-size: 0.66rem; color: var(--dim); }
  .cm-bar .sp { flex: 1; }
  .cm-btn {
    min-width: 40px;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md, 8px);
    background: transparent;
    color: var(--text);
    font-size: 0.74rem;
  }
  .cm-btn.primary {
    background: var(--primary-bg);
    color: var(--primary-text);
    border-color: transparent;
  }
  .cm-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 6px 8px;
    color: var(--term-text);
    -webkit-overflow-scrolling: touch;
  }
  /* 克隆节点由 JS 插入，不带 scope 属性，必须用 :global 命中 */
  .cm-content :global(.xterm-rows),
  .cm-content :global(.xterm-rows > div) {
    white-space: pre;
  }
  .cm-content :global(.cm-rows) {
    user-select: text;
    -webkit-user-select: text;
    -webkit-touch-callout: default;
  }
  .cm-empty { color: var(--term-dim); font-size: 0.72rem; padding: 8px 2px; }
</style>
