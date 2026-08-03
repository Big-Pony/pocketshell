<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import type { Terminal } from "@xterm/xterm";
  import {
    termFontFromOptions,
    cleanCapture,
    COPY_PAGE_ROWS,
    pageRange,
    prependPage,
    keepScrollAnchored,
  } from "../lib/term/term-clone";
  import type { Connection } from "../lib/net/connection";
  import type { TermCaptureResult } from "../lib/net/protocol";
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
  //
  // It arrives a PAGE at a time, newest first (see term-clone's pagination
  // block): grabbing all ~2000 rows at once parked the view at the top of the
  // session, so the user had to scroll the whole way down to reach the output
  // they had just run, after waiting for every row to cross the wire.
  let { conn, sessionId, term, onClose, onCopy }: {
    conn: Connection;
    sessionId: string;
    term: Terminal | undefined;
    onClose: () => void;
    onCopy: (text: string) => void;
  } = $props();

  let holder: HTMLPreElement;
  let box: HTMLDivElement;
  let text = $state("");
  let loading = $state(true); // the very first page — nothing on screen yet
  let loadingMore = $state(false); // an older page, with text already shown
  let atTop = $state(false); // agent says there is nothing earlier
  let nextPage = 0;
  let cancelled = false;
  let empty = $derived(!loading && text === "");
  let rows = $derived(text === "" ? 0 : text.split("\n").length);

  // Fetch one page and hand back its cleaned text. Older pages keep their
  // trailing blank rows: only a capture running to the bottom of the screen has
  // tmux's padding slab, mid-scrollback blanks are real gaps between commands.
  async function fetchPage(n: number): Promise<string> {
    const { back, endBack } = pageRange(n);
    const r = (await conn.rpc("term.capture", { session: sessionId, back, endBack })) as TermCaptureResult;
    if (r?.atTop) atTop = true;
    return r?.data ? cleanCapture(new TextDecoder().decode(fromB64(r.data)), n > 0) : "";
  }

  // Load the block above what is shown, keeping the user's view where it was.
  //
  // Triggered by scrolling to the top rather than run in the background on
  // purpose: scrolling and selecting are mutually exclusive gestures, so a load
  // started this way can never mutate the DOM out from under a long-press
  // selection that is in progress.
  async function loadOlder() {
    if (loading || loadingMore || atTop || cancelled) return; // one at a time
    loadingMore = true;
    try {
      const older = await fetchPage(nextPage);
      if (cancelled) return;
      nextPage++;
      if (!older) return;
      // Content added ABOVE the viewport pushes everything down by the height it
      // added; scrollTop has to move with it or the view snaps to the older text.
      const before = box.scrollHeight;
      const top = box.scrollTop;
      text = prependPage(older, text);
      await new Promise(requestAnimationFrame); // let layout settle first
      if (cancelled) return;
      box.scrollTop = keepScrollAnchored({ before, after: box.scrollHeight, scrollTop: top });
    } catch {
      // Offline / dead pane: keep what is already loaded and let the next scroll
      // to the top try again rather than wiping the overlay.
    } finally {
      if (!cancelled) loadingMore = false;
    }
  }

  // Near the top, not exactly at it: momentum scrolling on iOS rarely settles on
  // a clean 0, and the load wants to be underway before the user gets there.
  const NEAR_TOP_PX = 120;
  function onScroll() {
    if (box.scrollTop <= NEAR_TOP_PX) void loadOlder();
  }

  onMount(() => {
    // Match the live terminal's metrics so the overlay's text lines up with what
    // the user was just looking at. These come from xterm's OPTIONS, not from
    // getComputedStyle: xterm never writes its font size to CSS, so the computed
    // style reports the page's inherited size and the overlay came up bigger
    // than the terminal it covers.
    if (holder) {
      const font = termFontFromOptions(term?.options);
      holder.style.fontFamily = font.fontFamily;
      holder.style.fontSize = font.fontSize;
      holder.style.lineHeight = font.lineHeight;
      holder.style.letterSpacing = font.letterSpacing;
    }
    void (async () => {
      try {
        text = await fetchPage(nextPage);
        if (cancelled) return;
        nextPage++;
      } catch {
        if (!cancelled) text = ""; // offline / dead pane → the empty hint
      } finally {
        if (cancelled) return;
        loading = false;
        // Open on the NEWEST output, which is what copy mode is for.
        await new Promise(requestAnimationFrame);
        if (!cancelled && box) box.scrollTop = box.scrollHeight;
      }
    })();
    return () => { cancelled = true; };
  });

  function selectAll() {
    // Only what is loaded — the button says so ("select loaded").
    const r = document.createRange();
    r.selectNodeContents(holder);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }
  function copySel() {
    // Prefer the user's selection; with none, "copy" most usefully means all the
    // text that is actually on screen. It is not necessarily the whole session,
    // which is why the row count and the "scroll up for more" hint are shown.
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
  <div class="cm-content" bind:this={box} onscroll={onScroll}>
    {#if !loading && !empty}
      <div class="cm-more" aria-live="polite">
        {#if loadingMore}{$t('copymode.loadingMore')}
        {:else if atTop}{$t('copymode.noMore')}
        {:else}{$t('copymode.scrollUpForMore')}{/if}
      </div>
    {/if}
    <pre class="cm-rows" bind:this={holder}>{text}</pre>
    {#if loading}<div class="cm-empty">{$t('copymode.loading')}</div>{/if}
    {#if empty}<div class="cm-empty">{$t('copymode.empty')}</div>{/if}
    {#if !loading && !empty}
      <div class="cm-count">{$t('copymode.loadedRows', { values: { n: rows } })}</div>
    {/if}
  </div>
</div>

<style>
  /* 覆盖层盖住终端区。文本区固定深色（--term-*，6 套主题一致）；bar 走语义令牌 */
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
    /* overflow-y only: long lines wrap now, so there is nothing to scroll
       sideways and a stray horizontal pan would just fight the selection. */
    overflow-x: hidden;
    overflow-y: auto;
    padding: 6px 8px;
    color: var(--term-text);
    -webkit-overflow-scrolling: touch;
  }
  /* 按屏宽折行：手机上横向滚动去读一行长输出既难选中又容易误触。
     pre-wrap 保留空白与缩进，anywhere 让没有空格的超长串（URL、base64、
     哈希）也能断开，否则它们仍会把内容顶出屏幕。
     user-select + touch-callout 是手机长按能唤起系统选择手柄的关键。 */
  .cm-rows {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    color: var(--term-text);
    user-select: text;
    -webkit-user-select: text;
    -webkit-touch-callout: default;
  }
  .cm-empty { color: var(--term-dim); font-size: 0.72rem; padding: 8px 2px; }
  /* 分页提示不参与选中，免得「全选已载」把它们也一起复制走 */
  .cm-more, .cm-count {
    color: var(--term-dim);
    font-size: 0.68rem;
    text-align: center;
    padding: 6px 2px;
    user-select: none;
    -webkit-user-select: none;
  }
</style>
