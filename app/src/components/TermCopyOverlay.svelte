<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import type { Terminal } from "@xterm/xterm";
  import { readTermFont, cleanCapture } from "../lib/term-clone";
  import type { Connection } from "../lib/connection";
  import type { TermCaptureResult } from "../lib/protocol";
  import { fromB64 } from "../lib/bytes";

  // Copy mode: cover the terminal with plain, selectable text so a mobile
  // long-press can select it natively (xterm hijacks touch into scrolling).
  //
  // The text comes from the agent (`term.capture`, colours off → tmux emits
  // clean plain text), NOT from the terminal's DOM. The old implementation
  // cloned xterm's `.xterm-rows`; under the WebGL renderer those rows do not
  // exist and the overlay came up blank. Asking tmux is also simply better
  // source data: not capped by xterm's scrollback, and `-J` restores folded
  // long lines instead of the hard-wrapped copies the frontend holds.
  // Colours are lost — accepted, the clipboard wants text.
  let { conn, sessionId, term, onClose, onCopy }: {
    conn: Connection;
    sessionId: string;
    term: Terminal | undefined;
    onClose: () => void;
    onCopy: (text: string) => void;
  } = $props();

  let holder: HTMLPreElement;
  let text = $state("");
  let loading = $state(true);
  let empty = $derived(!loading && text.trim() === "");

  onMount(() => {
    // Keep the live terminal's metrics so the overlay's text lines up with what
    // the user was just looking at.
    const root = term?.element;
    if (root && holder) {
      const font = readTermFont(getComputedStyle(root));
      holder.style.fontFamily = font.fontFamily;
      holder.style.fontSize = font.fontSize;
      holder.style.lineHeight = font.lineHeight;
      holder.style.letterSpacing = font.letterSpacing;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = (await conn.rpc("term.capture", { session: sessionId })) as TermCaptureResult;
        if (cancelled) return;
        text = r?.data ? cleanCapture(new TextDecoder().decode(fromB64(r.data))) : "";
      } catch {
        if (!cancelled) text = ""; // offline / dead pane → the empty hint
      } finally {
        if (!cancelled) loading = false;
      }
    })();
    return () => { cancelled = true; };
  });

  function selectAll() {
    const r = document.createRange();
    r.selectNodeContents(holder);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }
  function copySel() {
    // Prefer the user's selection; with none, "copy" on a screenful of text most
    // usefully means all of it rather than nothing.
    const s = window.getSelection()?.toString() ?? "";
    onCopy(s.trim() ? s : text);
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
    <pre class="cm-rows" bind:this={holder}>{text}</pre>
    {#if loading}<div class="cm-empty">{$t('copymode.loading')}</div>{/if}
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
  /* 纯文本一份，长行不折（与终端一致，横向滚动由 .cm-content 提供）。
     user-select + touch-callout 是手机长按能唤起系统选择手柄的关键。 */
  .cm-rows {
    margin: 0;
    white-space: pre;
    color: var(--term-text);
    user-select: text;
    -webkit-user-select: text;
    -webkit-touch-callout: default;
  }
  .cm-empty { color: var(--term-dim); font-size: 0.72rem; padding: 8px 2px; }
</style>
