<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import { Connection } from "../lib/connection";
  import { splitLines, highlightTo } from "../lib/highlight";
  import { previewKind, previewOrigin, previewUrl, relFromBase } from "../lib/preview";
  import HtmlView from "./HtmlView.svelte";
  import PreviewDirDrawer from "./PreviewDirDrawer.svelte";

  let { conn, path, mode, active, base, onToast, onEditingChange, onDirtyChange, autoEdit, onAutoEdit, onNavigate }: {
    conn: Connection; path: string; mode: "code" | "diff"; active: boolean;
    base?: string;
    onToast: (m: string) => void;
    onEditingChange?: (editing: boolean) => void;
    onDirtyChange?: (dirty: boolean) => void;
    autoEdit?: boolean;
    onAutoEdit?: () => void;
    onNavigate?: (path: string) => void;
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
  // render/source view toggle for md/html/image; plain code stays "source".
  let view = $state<"render" | "source">("source");
  // The kind-default view is applied only on the FIRST load of this tab; reloads
  // (⟳ / exit-edit) preserve whatever view the user is on, so editing then
  // closing returns to the view they entered from instead of snapping to render.
  let initialViewSet = $state(false);
  let enterView = $state<"render" | "source">("source");
  let imgSrc = $state("");
  let htmlSrc = $state("");
  let MarkdownComp = $state<any>(null);
  let mdToken = $state(""); // one token per md render, reused for all local images
  let previewFullscreen = $state(false);
  let drawerOpen = $state(false);
  let drawerRoot = $state(""); // anchored to dirOf(path) at fullscreen entry, held for the session

  const kind = $derived(previewKind(path));
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  // scope = the token's base subtree. Use the project-root bookmark ONLY when it
  // is an ancestor of this file (else relFromBase escapes base → the /preview
  // route's traversal guard 403s). Otherwise fall back to the file's own dir.
  const scope = $derived(
    base && (path === base || path.startsWith((base.endsWith("/") ? base : base + "/")))
      ? base
      : dirOf(path),
  );

  function origin(): string {
    return previewOrigin(conn.agentUrl);
  }
  async function mintUrl(relpath: string): Promise<string> {
    const { token } = (await conn.rpc("preview.mint", { base: scope })) as { token: string };
    return previewUrl(origin(), token, relpath);
  }
  async function loadImage() {
    try { imgSrc = await mintUrl(relFromBase(scope, path)); }
    catch { notice = tr("preview.imageFailed"); }
  }

  // md images are relative to the md file's dir, but the token base is `scope`
  // (project root). Resolve the image to an absolute path, then re-express it
  // relative to scope so the /preview route serves it within the token subtree.
  function joinResolve(dir: string, rel: string): string {
    const out: string[] = [];
    for (const p of (dir + "/" + rel).split("/")) {
      if (p === "" || p === ".") continue;
      if (p === "..") out.pop(); else out.push(p);
    }
    return "/" + out.join("/");
  }
  // Sync: reuse the single token minted for this render (mdToken) instead of one
  // preview.mint RPC per image. Same scope subtree, so one token covers them all.
  function mdImageUrl(relToDir: string): string {
    const abs = joinResolve(dirOf(path), relToDir);
    return previewUrl(origin(), mdToken, relFromBase(scope, abs));
  }

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
    if (kind === "image") { view = "render"; await loadImage(); return; }
    if (!initialViewSet) {
      view = kind === "markdown" || kind === "html" ? "render" : "source";
      initialViewSet = true;
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
      if (kind === "markdown") {
        try {
          // Mint ONE token up-front; every local image reuses it (no per-image RPC).
          const { token } = (await conn.rpc("preview.mint", { base: scope })) as { token: string };
          mdToken = token;
          MarkdownComp = (await import("./MarkdownView.svelte")).default; // lazy chunk
        } catch { onToast(tr("preview.mdFailed")); view = "source"; }
      }
      if (kind === "html") {
        // cache-bust so ⟳ / re-mint always reloads the iframe with fresh bytes.
        try { htmlSrc = (await mintUrl(relFromBase(scope, path))) + `?_=${Date.now()}`; }
        catch { onToast(tr("preview.htmlFailed")); view = "source"; }
      }
    } catch (e: any) {
      notice = e?.message ?? tr("preview.readFailed");
      lines = []; html = ""; plain = false; canEdit = false;
    }
  }

  async function startEdit() {
    if (!canEdit || editing) return;
    enterView = view; // remember where to land when the editor closes
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
    view = enterView; // return to the read view we entered edit from
    loaded = ""; // force re-read on next $effect tick — the file may have changed
  }
  // Refresh: re-mint token + reload content. Covers token expiry (reconnect /
  // session change) and external edits (terminal / Claude touched the file).
  async function refresh() {
    if (kind === "image") { await loadImage(); return; }
    loaded = ""; // force re-read/re-render on next $effect tick
  }

  function enterFullscreen() { drawerRoot = dirOf(path); previewFullscreen = true; }

  $effect(() => { if (autoEdit && active && canEdit && !editing) { void startEdit(); onAutoEdit?.(); } });
  $effect(() => { if (active && loaded !== path + mode) { loaded = path + mode; void load(); } });

  // Leaving/hiding this tab drops fullscreen + drawer so they can't get stuck off-screen.
  $effect(() => { if (!active) { previewFullscreen = false; drawerOpen = false; } });

  // Esc and the browser/hardware Back both exit fullscreen. A pushed history
  // entry lets Back pop it; exiting via the button removes that entry.
  $effect(() => {
    if (!previewFullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") previewFullscreen = false; };
    const onPop = () => { previewFullscreen = false; };
    history.pushState({ psFs: true }, "");
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      if ((history.state as { psFs?: boolean } | null)?.psFs) history.back();
    };
  });
</script>

<div class="preview" class:hidden={!active} class:fs={previewFullscreen}>
  {#if editing && FileEditorComp}
    <FileEditorComp {conn} {path} lang={fileLang} initialContent={raw} mtime={fileMtime}
      onClose={exitEdit} onDirty={(d: boolean) => onDirtyChange?.(d)} {onToast} />
  {:else}
    {#if mode === "code"}
      <div class="pv-bar">
        {#if kind === "markdown" || kind === "html"}
          <div class="seg">
            <button class:on={view === "render"} onclick={() => (view = "render")}>{$t('preview.viewRender')}</button>
            <button class:on={view === "source"} onclick={() => (view = "source")}>{$t('preview.viewSource')}</button>
          </div>
        {:else if kind === "image"}
          <span class="pv-label">{$t('preview.imageLabel')}</span>
        {/if}
        <span class="sp"></span>
        {#if previewFullscreen}
          <button class="pv-btn" onclick={() => (drawerOpen = !drawerOpen)}>{$t('preview.dir')}</button>
          <button class="pv-btn" onclick={() => { previewFullscreen = false; drawerOpen = false; }}>{$t('preview.exitFullscreen')}</button>
        {:else}
          {#if kind !== "image" && canEdit}
            <button class="pv-btn" onclick={startEdit}>{$t('editor.edit')}</button>
          {/if}
          <button class="pv-btn" aria-label={$t('preview.fullscreen')} onclick={enterFullscreen}>⛶</button>
        {/if}
        {#if kind !== "code"}
          <button class="pv-btn" aria-label={$t('preview.refresh')} onclick={refresh}>⟳</button>
        {/if}
      </div>
    {/if}

    <div class="pv-content" data-view={view}>
      {#if kind === "image"}
        <div class="img-wrap">{#if imgSrc}<img src={imgSrc} alt={path} />{/if}</div>
      {:else if kind === "markdown" && view === "render" && MarkdownComp}
        <MarkdownComp source={raw} mdFileDir={dirOf(path)}
          buildImageUrl={mdImageUrl}
          onFail={() => { view = "source"; onToast(tr("preview.mdFailed")); }} />
      {:else if kind === "html" && view === "render"}
        <HtmlView src={htmlSrc} />
      {:else}
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
  {/if}

  {#if previewFullscreen}
    <PreviewDirDrawer {conn} rootDir={drawerRoot} currentPath={path} open={drawerOpen}
      onSelect={(p) => { drawerOpen = false; onNavigate?.(p); }}
      onClose={() => (drawerOpen = false)} />
  {/if}
</div>

<style>
  /* 代码区跟随主题（--code-*）；终端区仍固定深色 --term-* */
  .preview { width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--code-bg); color: var(--code-fg); }
  .hidden { display: none; }
  /* 应用内全屏覆盖层：盖住上下区 + tab 栏 + 底栏（z-index 高于 .overlay=40） */
  .preview.fs { position: fixed; inset: 0; z-index: 60; }
  /* 常驻头部栏：与 FileEditor 的 .ed-bar 同规格（同高、同底色/边框）防切换抖动 */
  .pv-bar { display: flex; align-items: center; gap: 4px; height: 40px; box-sizing: border-box; padding: 4px 8px; background: var(--panel); border-bottom: 1px solid var(--line); flex: 0 0 auto; }
  .pv-bar .sp { flex: 1; }
  /* pan-y: let horizontal drags fall through to the top-area swipe (tab switch,
     req8) instead of being swallowed as horizontal scroll; vertical still pans. */
  .pv-content { flex: 1; min-height: 0; overflow: auto; touch-action: pan-y; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: var(--radius-md, 8px); overflow: hidden; }
  .seg button { height: 30px; padding: 0 12px; background: transparent; color: var(--dim); border: none; font-size: 0.72rem; }
  .seg button.on { background: var(--primary-bg); color: var(--primary-text); }
  .pv-btn { min-width: 40px; height: 32px; border: 1px solid var(--line); border-radius: var(--radius-md, 8px); background: transparent; color: var(--text); font-size: 0.78rem; }
  .pv-label { font-size: 0.72rem; color: var(--dim); }
  .img-wrap { display: flex; justify-content: center; padding: 12px; }
  .img-wrap img { max-width: 100%; height: auto; }
  .pv-notice { font-size: 0.7rem; color: var(--amber); padding: 6px 10px; }
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
