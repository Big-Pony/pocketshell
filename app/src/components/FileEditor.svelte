<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, scrollPastEnd, type Panel } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle, indentUnit } from "@codemirror/language";
  import { defaultKeymap, history, historyKeymap, undo, redo } from "@codemirror/commands";
  import { search, openSearchPanel, closeSearchPanel, searchPanelOpen, SearchQuery, setSearchQuery, findNext, findPrevious, replaceNext, replaceAll } from "@codemirror/search";
  import { tags } from "@lezer/highlight";
  import { langExtension, saveFile, isConflictError } from "../lib/editor";
  import { visibleHeightBelow, shouldRecenterCursor } from "../lib/term/keyboard-inset";
  import type { Connection } from "../lib/net/connection";

  let { conn, path, lang, initialContent, mtime, onClose, onDirty, onToast }: {
    conn: Connection; path: string; lang: string; initialContent: string; mtime: number;
    onClose: () => void; onDirty: (d: boolean) => void; onToast: (msg: string) => void;
  } = $props();

  let rootEl = $state<HTMLDivElement>();
  let host = $state<HTMLDivElement>();
  let view: EditorView | null = null;
  let dirty = $state(false);
  let saving = $state(false);
  let conflictOpen = $state(false);
  let unsavedOpen = $state(false);
  // curMtime is intentionally a mutable snapshot of the prop; the file's open-time mtime never changes.
  // svelte-ignore state_referenced_locally
  let curMtime = $state(mtime);
  let closeAfterSave = false;
  const fileName = $derived(path.split("/").pop() ?? path);

  function setDirty(d: boolean) { if (dirty !== d) { dirty = d; onDirty(d); } }

  // Both palettes live in --code-* CSS vars, so ONE theme follows the app
  // theme switch with no editor reconfiguration.
  const theme = EditorView.theme({
    "&": { background: "var(--code-bg)", color: "var(--code-fg)", height: "100%", fontSize: "0.72rem" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.5" },
    ".cm-content": { caretColor: "var(--code-cursor)" },
    ".cm-cursor": { borderLeftColor: "var(--code-cursor)" },
    ".cm-gutters": { background: "var(--code-bg)", color: "var(--code-gutter)", border: "none" },
    ".cm-activeLine": { background: "var(--code-active-line)" },
    ".cm-activeLineGutter": { background: "var(--code-active-line)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { background: "var(--code-selection)" },
    ".cm-panels": { background: "var(--panel)", color: "var(--text)", borderBottom: "1px solid var(--line)" },
  });
  const hl = HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: "var(--code-keyword)" },
    { tag: [tags.string, tags.regexp, tags.special(tags.string)], color: "var(--code-string)" },
    { tag: tags.comment, color: "var(--code-comment)" },
    { tag: [tags.number, tags.bool, tags.null], color: "var(--code-number)" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--code-func)" },
    { tag: [tags.typeName, tags.className], color: "var(--code-type)" },
    { tag: [tags.propertyName, tags.attributeName], color: "var(--code-attr)" },
  ]);

  // Compact mobile search panel replacing CM6's desktop default. tr() strings
  // are our own dictionary — safe for innerHTML.
  function makeSearchPanel(v: EditorView): Panel {
    const dom = document.createElement("div");
    dom.className = "ed-search";
    dom.innerHTML = `
      <div class="row">
        <input class="q mono" placeholder="${tr("editor.searchPh")}">
        <span class="cnt"></span>
        <button class="prev" aria-label="${tr("editor.prev")}">↑</button>
        <button class="next" aria-label="${tr("editor.next")}">↓</button>
        <button class="rt" aria-label="${tr("editor.replace")}">⇄</button>
        <button class="x" aria-label="${tr("editor.close")}">✕</button>
      </div>
      <div class="row rep hidden">
        <input class="r mono" placeholder="${tr("editor.replacePh")}">
        <button class="r1">${tr("editor.replace")}</button>
        <button class="ra">${tr("editor.replaceAll")}</button>
      </div>`;
    const q = dom.querySelector<HTMLInputElement>(".q")!;
    const r = dom.querySelector<HTMLInputElement>(".r")!;
    const cnt = dom.querySelector<HTMLSpanElement>(".cnt")!;
    const query = () => new SearchQuery({ search: q.value, replace: r.value, caseSensitive: false, literal: true });
    function updateCount() {
      if (!q.value) { cnt.textContent = ""; return; }
      const cur = query().getCursor(v.state);
      const sel = v.state.selection.main;
      let total = 0, at = 0;
      for (let m = cur.next(); !m.done && total < 999; m = cur.next()) {
        total++;
        if (m.value.from === sel.from && m.value.to === sel.to) at = total;
      }
      cnt.textContent = total ? `${at || "–"}/${total}` : tr("editor.noMatch");
    }
    const commit = () => { v.dispatch({ effects: setSearchQuery.of(query()) }); updateCount(); };
    q.addEventListener("input", commit);
    r.addEventListener("input", () => v.dispatch({ effects: setSearchQuery.of(query()) }));
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); findNext(v); updateCount(); } });
    dom.querySelector(".next")!.addEventListener("click", () => { findNext(v); updateCount(); });
    dom.querySelector(".prev")!.addEventListener("click", () => { findPrevious(v); updateCount(); });
    dom.querySelector(".rt")!.addEventListener("click", () => dom.querySelector(".rep")!.classList.toggle("hidden"));
    dom.querySelector(".r1")!.addEventListener("click", () => { replaceNext(v); updateCount(); });
    dom.querySelector(".ra")!.addEventListener("click", () => { replaceAll(v); updateCount(); });
    dom.querySelector(".x")!.addEventListener("click", () => closeSearchPanel(v));
    return { dom, top: true, mount: () => q.focus() };
  }

  function toggleSearch() {
    if (!view) return;
    if (searchPanelOpen(view.state)) closeSearchPanel(view); else openSearchPanel(view);
  }

  // 键盘感知高度。两平台的键盘对视口做的事不同，几何计算在
  // lib/term/keyboard-inset.ts 的 visibleHeightBelow 里（有单测）：
  //  - Android：Keyboard.svelte 设了 overlaysContent=true，键盘覆盖内容、
  //    visualViewport 不收缩，必须读 virtualKeyboard.boundingRect.height。
  //  - iOS：浏览器收缩 visual viewport，读 vv 即可。
  // 读不到 virtualKeyboard 时 vkHeight 为 0，自然落到 iOS 分支。
  // 上一次算出的编辑区高度，用来判断这次是变矮还是变高（见 shouldRecenterCursor）。
  let lastFitHeight: number | undefined;

  function fitViewport() {
    if (!rootEl) return;
    const vv = window.visualViewport;
    const vk = (navigator as any).virtualKeyboard;
    const h = visibleHeightBelow({
      top: rootEl.getBoundingClientRect().top,
      innerHeight: window.innerHeight,
      vvHeight: vv?.height ?? window.innerHeight,
      vvOffsetTop: vv?.offsetTop ?? 0,
      vkHeight: vk?.boundingRect?.height ?? 0,
    });
    rootEl.style.height = h + "px";
    // 只在编辑区**变矮**时把光标滚回视野（键盘弹起、可能正压着光标）。
    // 无条件滚会劫持用户的滚动：光标在没点过正文时停在文件开头，而 Android
    // 上滚到底部会触发 URL 栏收放 → resize → 这里 → 弹回顶部。
    const recenter = shouldRecenterCursor(lastFitHeight, h);
    lastFitHeight = h;
    if (recenter && view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
  }

  async function doSave(force = false) {
    if (saving || !view) return;
    saving = true;
    try {
      const r = await saveFile(conn, path, view.state.doc.toString(), force ? undefined : curMtime);
      curMtime = r.mtime;
      setDirty(false);
      conflictOpen = false;
      onToast(tr("editor.saveOk"));
      if (closeAfterSave) { closeAfterSave = false; onClose(); }
    } catch (e: any) {
      closeAfterSave = false;
      if (isConflictError(e)) conflictOpen = true;
      else onToast(tr("editor.saveFailed") + ": " + (e?.message ?? ""));
    } finally { saving = false; }
  }

  function requestClose() { if (dirty) unsavedOpen = true; else onClose(); }

  onMount(async () => {
    const langExt = await langExtension(lang);
    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        lineNumbers(), history(), drawSelection(), indentOnInput(), bracketMatching(),
        highlightActiveLine(), indentUnit.of("  "),
        // 手机端不做横向滚动：长行软换行以适配屏宽。CM6 的 lineNumbers()
        // 原生处理软换行（一个逻辑行一个行号，续行留空），无需额外对齐处理。
        EditorView.lineWrapping,
        // 底部留白（13 期需求 1b）：留出「视口高度减一行」的空白，最后一行
        // 可以拖到编辑区顶部。用 CM 官方扩展而非手写 padding-bottom——CM 的
        // 滚动测量与 scrollIntoView 原生认它，自己加 padding 会让行定位错位。
        scrollPastEnd(),
        search({ top: true, createPanel: makeSearchPanel }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        syntaxHighlighting(hl), theme,
        EditorView.updateListener.of((u) => { if (u.docChanged) setDirty(true); }),
        ...(langExt ? [langExt] : []),
      ],
    });
    view = new EditorView({ state, parent: host! });
    view.focus();
    window.visualViewport?.addEventListener("resize", fitViewport);
    // Android（VirtualKeyboard API）：键盘弹起不改变 visualViewport，所以
    // 上面那个 resize **不会触发**——必须另外听 geometrychange，否则这条
    // 修复在 Android 上等于没做。
    (navigator as any).virtualKeyboard?.addEventListener?.("geometrychange", fitViewport);
    fitViewport();
  });
  onDestroy(() => {
    window.visualViewport?.removeEventListener("resize", fitViewport);
    (navigator as any).virtualKeyboard?.removeEventListener?.("geometrychange", fitViewport);
    view?.destroy();
    onDirty(false);
  });
</script>

<div class="ed-root" bind:this={rootEl}>
  <div class="ed-bar">
    <span class="ed-name mono" title={path}>{#if dirty}<span class="dot"></span>{/if}{fileName}</span>
    <span class="sp"></span>
    <button class="ed-btn" aria-label={$t('editor.undo')} onclick={() => view && undo(view)}>↶</button>
    <button class="ed-btn" aria-label={$t('editor.redo')} onclick={() => view && redo(view)}>↷</button>
    <button class="ed-btn" aria-label={$t('editor.find')} onclick={toggleSearch}>⌕</button>
    <button class="ed-btn primary" disabled={saving || !dirty} onclick={() => doSave(false)}>{$t('editor.save')}</button>
    <button class="ed-btn" aria-label={$t('editor.close')} onclick={requestClose}>✕</button>
  </div>
  <div class="ed-host" bind:this={host}></div>

  {#if conflictOpen}
    <div class="ed-overlay" role="presentation" onclick={() => (conflictOpen = false)}>
      <div class="ed-dlg" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === "Escape") conflictOpen = false; }}>
        <div class="dlg-title">{$t('editor.conflictTitle')}</div>
        <div class="dlg-body">{$t('editor.conflictBody')}</div>
        <div class="dlg-btns">
          <button onclick={() => (conflictOpen = false)}>{$t('common.cancel')}</button>
          <button onclick={() => { conflictOpen = false; onClose(); }}>{$t('editor.reloadFile')}</button>
          <button class="danger" onclick={() => doSave(true)}>{$t('editor.overwrite')}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if unsavedOpen}
    <div class="ed-overlay" role="presentation" onclick={() => (unsavedOpen = false)}>
      <div class="ed-dlg" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === "Escape") unsavedOpen = false; }}>
        <div class="dlg-title">{$t('editor.unsavedTitle')}</div>
        <div class="dlg-body">{$t('editor.unsavedBody')}</div>
        <div class="dlg-btns">
          <button onclick={() => (unsavedOpen = false)}>{$t('common.cancel')}</button>
          <button class="danger" onclick={() => { unsavedOpen = false; onClose(); }}>{$t('editor.discard')}</button>
          <button class="ok" onclick={() => { unsavedOpen = false; closeAfterSave = true; void doSave(false); }}>{$t('editor.saveAndClose')}</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .ed-root { display: flex; flex-direction: column; width: 100%; height: 100%; background: var(--code-bg); }
  /* height fixed to match FilePreview's .pv-bar so preview↔edit does not jitter */
  .ed-bar { display: flex; align-items: center; gap: 4px; height: 40px; box-sizing: border-box; padding: 4px 8px; background: var(--panel); border-bottom: 1px solid var(--line); flex: 0 0 auto; }
  .ed-name { font-size: 0.72rem; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; display: flex; align-items: center; gap: 5px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--amber); flex: 0 0 auto; }
  .sp { flex: 1; }
  .ed-btn { min-width: 40px; height: 32px; border: 1px solid var(--line); border-radius: var(--radius-md, 8px); background: transparent; color: var(--text); font-size: 0.78rem; }
  .ed-btn:disabled { opacity: 0.45; }
  .ed-btn.primary { background: var(--primary-bg); color: var(--primary-text); border-color: transparent; }
  .ed-host { flex: 1; min-height: 0; overflow: hidden; }
  .ed-host :global(.cm-editor) { height: 100%; }
  .ed-host :global(.ed-search) { padding: 4px 8px; display: flex; flex-direction: column; gap: 4px; }
  .ed-host :global(.ed-search .row) { display: flex; align-items: center; gap: 4px; }
  .ed-host :global(.ed-search .row.hidden) { display: none; }
  .ed-host :global(.ed-search input) { flex: 1; min-width: 0; height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--radius-md, 8px); background: var(--code-bg); color: var(--code-fg); font-size: 0.72rem; }
  .ed-host :global(.ed-search button) { min-width: 34px; height: 30px; border: 1px solid var(--line); border-radius: var(--radius-md, 8px); background: transparent; color: var(--text); font-size: 0.72rem; }
  .ed-host :global(.ed-search .cnt) { font-size: 0.66rem; color: var(--dim); white-space: nowrap; }
  .ed-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
  .ed-dlg { background: var(--dlg-bg, var(--panel)); border: 1px solid var(--line); border-radius: var(--radius-xl, 14px); padding: 18px; width: min(300px, 86vw); }
  .dlg-title { font-size: 0.85rem; font-weight: 600; color: var(--text); margin-bottom: 8px; }
  .dlg-body { font-size: 0.74rem; color: var(--dim); margin-bottom: 14px; }
  .dlg-btns { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .dlg-btns button { height: 32px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--radius-md, 8px); background: transparent; color: var(--text); font-size: 0.74rem; }
  .dlg-btns .ok { background: var(--primary-bg); color: var(--primary-text); border-color: transparent; }
  .dlg-btns .danger { color: var(--red); border-color: var(--red); }
</style>
