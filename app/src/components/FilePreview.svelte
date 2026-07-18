<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import { Connection } from "../lib/connection";
  import { splitLines, highlightTo } from "../lib/highlight";

  let { conn, path, mode, active, onToast, onEditingChange, onDirtyChange, autoEdit, onAutoEdit }: {
    conn: Connection; path: string; mode: "code" | "diff"; active: boolean;
    onToast: (m: string) => void;
    onEditingChange?: (editing: boolean) => void;
    onDirtyChange?: (dirty: boolean) => void;
    autoEdit?: boolean;
    onAutoEdit?: () => void;
  } = $props();

  let lines = $state<string[]>([]);
  let html = $state("");
  let plain = $state(false); // R4: large file degraded to plain text (no gutter)
  let hunks = $state<{ header: string; lines: { kind: "add" | "del" | "ctx"; text: string }[] }[]>([]);
  let notice = $state("");
  let raw = $state("");            // un-highlighted content handed to the editor
  let fileMtime = $state(0);
  let fileLang = $state("plaintext");
  let canEdit = $state(false);
  let editing = $state(false);
  let FileEditorComp = $state<any>(null);
  let loaded = $state("");

  async function load() {
    notice = "";
    plain = false;
    canEdit = false;
    if (mode === "diff") {
      try {
        const r = (await conn.rpc("fs.diff", { path })) as { hunks: typeof hunks };
        hunks = r.hunks;
        if (!hunks.length) notice = tr("preview.noChanges");
      } catch (e: any) {
        notice = e?.message ?? tr("preview.diffFailed");
        hunks = [];
      }
      return;
    }
    try {
      const r = (await conn.rpc("fs.read", { path })) as { content: string; lang: string; mtime: number; truncated?: boolean; binary?: boolean };
      if (r.binary) { notice = tr("preview.binary"); lines = []; html = ""; canEdit = false; return; }
      if (r.truncated) notice = tr("preview.truncated");
      raw = r.content; fileMtime = r.mtime; fileLang = r.lang;
      canEdit = !r.truncated; // binary 已早退；截断文件维持只读
      // Line count for the gutter comes from the raw content; the highlighted
      // HTML is rendered as ONE block so multi-line tokens (block comments,
      // template literals) keep their spans intact — splitting the HTML on "\n"
      // would cut those spans and corrupt the coloring.
      // R4: oversized files come back plain → skip the per-line gutter (thousands
      // of divs) and show a hint; the HTML is already escaped, no XSS risk.
      const res = await highlightTo(r.lang, r.content);
      plain = res.plain;
      if (res.plain) notice = notice ? `${notice} · ${tr("preview.plainLarge")}` : tr("preview.plainLarge");
      lines = res.plain ? [] : splitLines(r.content);
      html = res.html;
    } catch (e: any) {
      notice = e?.message ?? tr("preview.readFailed");
      lines = []; html = ""; plain = false; canEdit = false;
    }
  }

  async function startEdit() {
    if (!canEdit || editing) return;
    try {
      FileEditorComp = (await import("./FileEditor.svelte")).default; // lazy chunk boundary
    } catch { onToast(tr("editor.loadFailed")); return; }
    editing = true;
    onEditingChange?.(true);
  }
  function exitEdit() {
    editing = false;
    onEditingChange?.(false);
    onDirtyChange?.(false);
    loaded = ""; // force re-read on next $effect tick — the file may have changed
  }
  $effect(() => { if (autoEdit && active && canEdit && !editing) { void startEdit(); onAutoEdit?.(); } });
  $effect(() => { if (active && loaded !== path + mode) { loaded = path + mode; void load(); } });
</script>

<div class="preview" class:hidden={!active}>
  {#if editing && FileEditorComp}
    <FileEditorComp {conn} {path} lang={fileLang} initialContent={raw} mtime={fileMtime}
      onClose={exitEdit} onDirty={(d: boolean) => onDirtyChange?.(d)} {onToast} />
  {:else}
    {#if canEdit && mode === "code"}
      <button class="edit-btn" onclick={startEdit}>{$t('editor.edit')}</button>
    {/if}
    {#if notice}<div class="pv-notice">{notice}</div>{/if}
    {#if mode === "diff"}
      <div class="diff">
        {#each hunks as h}
          <div class="hh mono">{h.header}</div>
          {#each h.lines as l}<div class="dl {l.kind}"><span class="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>{l.text}</div>{/each}
        {/each}
      </div>
    {:else}
      <div class="codewrap">
        {#if !plain}<div class="gutter" aria-hidden="true">{#each lines as _, i}<div class="ln">{i + 1}</div>{/each}</div>{/if}
        <pre class="code"><code>{@html html}</code></pre>
      </div>
    {/if}
  {/if}
</div>

<style>
  /* 代码区跟随主题（--code-*）；终端区仍固定深色 --term-* */
  .preview { width: 100%; height: 100%; overflow: auto; background: var(--code-bg); color: var(--code-fg); position: relative; }
  .hidden { display: none; }
  .pv-notice { font-size: 0.7rem; color: var(--amber); padding: 6px 10px; }
  .edit-btn { position: sticky; top: 6px; float: right; margin-right: 8px; z-index: 5; height: 30px; padding: 0 14px; border: 1px solid var(--line); border-radius: var(--radius-md, 8px); background: var(--panel); color: var(--text); font-size: 0.74rem; }
  .codewrap { display: flex; align-items: flex-start; padding: 8px 4px; font-size: 0.72rem; line-height: 1.5; font-family: "SF Mono", ui-monospace, Menlo, monospace; }
  .gutter { flex: 0 0 auto; text-align: right; padding-right: 1em; color: var(--code-gutter); user-select: none; }
  .gutter .ln { min-width: 2.2em; }
  .code { margin: 0; white-space: pre; }
  .code code { font: inherit; }
  .diff { padding: 8px 4px; font-size: 0.72rem; line-height: 1.5; font-family: "SF Mono", ui-monospace, Menlo, monospace; }
  .hh { color: var(--amber); margin: 6px 0 2px; }
  .dl { white-space: pre; }
  .dl.add { color: var(--ok); }
  .dl.del { color: var(--red); }
  .dl.ctx { color: var(--code-gutter); }
  .sign { display: inline-block; width: 1em; user-select: none; }
</style>
