<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, type Panel } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle, indentUnit } from "@codemirror/language";
  import { defaultKeymap, history, historyKeymap, undo, redo } from "@codemirror/commands";
  import { search, openSearchPanel, closeSearchPanel, searchPanelOpen, SearchQuery, setSearchQuery, findNext, findPrevious, replaceNext, replaceAll } from "@codemirror/search";
  import { tags } from "@lezer/highlight";
  import { langExtension, saveFile, isConflictError } from "../lib/editor";
  import type { Connection } from "../lib/connection";

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
  let curMtime = mtime;
  let closeAfterSave = false;
  const fileName = path.split("/").pop() ?? path;

  function setDirty(d: boolean) { if (dirty !== d) { dirty = d; onDirty(d); } }

  // Both palettes live in --code-* CSS vars, so ONE theme follows the app
  // theme switch with no editor reconfiguration.
  const theme = EditorView.theme({
    "&": { background: "var(--code-bg)", color: "var(--code-fg)", height: "100%", fontSize: "0.72rem" },
    ".cm-scroller": { fontFamily: '"SF Mono", ui-monospace, Menlo, monospace', lineHeight: "1.5" },
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

  // Keyboard-aware height: the on-screen keyboard shrinks visualViewport but
  // not the layout viewport — cap the editor to what is actually visible.
  function fitViewport() {
    const vv = window.visualViewport;
    if (!vv || !rootEl) return;
    rootEl.style.height = Math.max(160, vv.height - rootEl.getBoundingClientRect().top) + "px";
    if (view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
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
    fitViewport();
  });
  onDestroy(() => {
    window.visualViewport?.removeEventListener("resize", fitViewport);
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
      <div class="ed-dlg" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
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
      <div class="ed-dlg" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
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
  .ed-bar { display: flex; align-items: center; gap: 4px; padding: 4px 8px; background: var(--panel); border-bottom: 1px solid var(--line); flex: 0 0 auto; }
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
