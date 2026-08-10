<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import { Connection } from "../lib/net/connection";
  import { splitLines, highlightTo } from "../lib/highlight";
  import { previewKind, previewOrigin, previewUrl, relFromBase } from "../lib/preview";
  import HtmlView from "./HtmlView.svelte";
  import PreviewDirDrawer from "./PreviewDirDrawer.svelte";
  import { PREVIEW_WIDTHS, widthPxOf, scaleFor, type PreviewWidthId } from "../lib/ui/preview-width";
  import { loadSettings, saveSettings } from "../lib/settings";

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
  let videoSrc = $state("");
  let htmlSrc = $state("");
  let MarkdownComp = $state<any>(null);
  let mdToken = $state(""); // one token per md render, reused for all local images
  let previewFullscreen = $state(false);
  let drawerOpen = $state(false);
  let drawerRoot = $state(""); // anchored to dirOf(path) at fullscreen entry, held for the session

  // HTML 预览渲染宽度（14 期需求 1）。持久化在 settings，默认手机档。
  let widthId = $state<PreviewWidthId>(loadSettings().htmlPreviewWidth);
  let widthPickOpen = $state(false);
  // 内容区可用宽度。缩放要按它算，所以必须实测而非假设 innerWidth——
  // 全屏与非全屏、有无抽屉时可用宽度不同。
  let availW = $state(0);
  let contentEl = $state<HTMLElement | null>(null);

  const widthPx = $derived(widthPxOf(widthId));
  const previewScale = $derived(scaleFor(widthPx, availW));

  function pickWidth(id: PreviewWidthId) {
    widthId = id;
    widthPickOpen = false;
    saveSettings({ ...loadSettings(), htmlPreviewWidth: id });
  }

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
  async function loadVideo() {
    try { videoSrc = await mintUrl(relFromBase(scope, path)); }
    catch { notice = tr("preview.videoFailed"); }
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
    if (kind === "video") { view = "render"; await loadVideo(); return; }
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
    if (kind === "video") { await loadVideo(); return; }
    loaded = ""; // force re-read/re-render on next $effect tick
  }

  function enterFullscreen() { drawerRoot = dirOf(path); previewFullscreen = true; }

  $effect(() => { if (autoEdit && active && canEdit && !editing) { void startEdit(); onAutoEdit?.(); } });
  $effect(() => { if (active && loaded !== path + mode) { loaded = path + mode; void load(); } });

  // Leaving/hiding this tab drops fullscreen + drawer so they can't get stuck off-screen.
  $effect(() => { if (!active) { previewFullscreen = false; drawerOpen = false; widthPickOpen = false; } });

  // 容器尺寸随全屏切换/旋屏/键盘弹出而变，用 ResizeObserver 跟住。
  // jsdom 里 ResizeObserver 可能缺失，故降级为挂载时量一次——
  // 单测只关心档位与持久化，不验尺寸响应。
  $effect(() => {
    const el = contentEl;
    if (!el) return;
    const measure = () => { availW = el.clientWidth; };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

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
        {:else if kind === "video"}
          <span class="pv-label">{$t('preview.videoLabel')}</span>
        {/if}
        <span class="sp"></span>
        <!-- 尺寸档位：顶栏 390px 下已挤满，故收成一个按钮 + 底部弹层三选一。
             只在 HTML 渲染态出现——源码态与其他文件类型下这个旋钮没有意义。 -->
        {#if kind === "html" && view === "render"}
          <button class="pv-btn wbtn" onclick={() => (widthPickOpen = true)}>
            ▭ {$t(`preview.width.${widthId}`)}
          </button>
        {/if}
        {#if previewFullscreen}
          <button class="pv-btn" onclick={() => (drawerOpen = !drawerOpen)}>{$t('preview.dir')}</button>
          <button class="pv-btn" onclick={() => { previewFullscreen = false; drawerOpen = false; }}>{$t('preview.exitFullscreen')}</button>
        {:else}
          {#if kind !== "image" && kind !== "video" && canEdit}
            <button class="pv-btn" onclick={startEdit}>{$t('editor.edit')}</button>
          {/if}
          <button class="pv-btn" aria-label={$t('preview.fullscreen')} onclick={enterFullscreen}>⛶</button>
        {/if}
        {#if kind !== "code"}
          <button class="pv-btn" aria-label={$t('preview.refresh')} onclick={refresh}>⟳</button>
        {/if}
      </div>
    {/if}

    <!-- pad-bot：底部留白，让用户能把文件末尾的内容拖到屏幕中部（13 期需求 1b）。
         两类排除——图片/视频挂空白无意义；HTML 渲染态是 height:100% 的 iframe、
         内容在 iframe 内部滚动，外层留白只会拖出一片死空白。
         判据只看 kind 不掺 mode：上面的模板本就是先按 kind 分派的，
         kind 决定屏幕上真正渲染的是什么，条件与它对齐才不跑偏。 -->
    <div class="pv-content" data-view={view} bind:this={contentEl}
      class:pad-bot={kind !== "image" && kind !== "video" && !(kind === "html" && view === "render")}>
      {#if kind === "image"}
        <div class="img-wrap">{#if imgSrc}<img src={imgSrc} alt={path} />{/if}</div>
      {:else if kind === "video"}
        <div class="video-wrap">
          {#if videoSrc}
            <!-- playsinline 阻止 iOS 强制全屏接管；preload=metadata 只取时长
                 与首帧，不预下整个文件（手机流量场景） -->
            <video src={videoSrc} controls playsinline preload="metadata">
              <track kind="captions" />
              {$t('preview.videoUnsupported')}
            </video>
          {/if}
        </div>
      {:else if kind === "markdown" && view === "render" && MarkdownComp}
        <MarkdownComp source={raw} mdFileDir={dirOf(path)}
          buildImageUrl={mdImageUrl}
          onFail={() => { view = "source"; onToast(tr("preview.mdFailed")); }} />
      {:else if kind === "html" && view === "render"}
        <HtmlView src={htmlSrc} {widthPx} scale={previewScale} />
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

  {#if widthPickOpen}
    <!-- 形态复用 GitReview 的 .bpick：底部弹出、拇指可达、已验证的入场动画。
         遮罩用 keydown 监听 Esc 而非 onclick 的键盘等价物——对一块用来退出的
         空白区域，Enter/Space 的「激活」语义说不通。 -->
    <div
      class="wp-mask"
      role="button"
      tabindex="-1"
      aria-label={$t('common.close')}
      onclick={() => (widthPickOpen = false)}
      onkeydown={(e) => { if (e.key === "Escape") widthPickOpen = false; }}
    ></div>
    <div class="wpick">
      <div class="wp-title">{$t('preview.width.title')}</div>
      {#each PREVIEW_WIDTHS as w (w.id)}
        <button class="wp-item" class:on={w.id === widthId} onclick={() => pickWidth(w.id)}>
          {$t(`preview.width.${w.id}`)} <span class="wp-sub mono">· {w.px}px</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* 代码区跟随主题（--code-*）。终端区从 2026-08-05 起也跟随主题明暗，
     两者同源于该主题的 .ghostty 调色板。 */
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
  /* 45vh ≈ 半屏：足以把最后一行拖到屏幕中部。用 vh 而非固定 px——
     小屏够用、大屏不浪费。
     .pv-content 既有的 touch-action: pan-y 保持不动：留白只增加可滚内容的
     长度，与「横向拖动落到上区 tab 切换手势」这条路由无关。 */
  .pv-content.pad-bot { padding-bottom: 45vh; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: var(--radius-md, 8px); overflow: hidden; }
  .seg button { height: 30px; padding: 0 12px; background: transparent; color: var(--dim); border: none; font-size: 0.72rem; }
  .seg button.on { background: var(--primary-bg); color: var(--primary-text); }
  .pv-btn { min-width: 40px; height: 32px; border: 1px solid var(--line); border-radius: var(--radius-md, 8px); background: transparent; color: var(--text); font-size: 0.78rem; }
  .pv-label { font-size: 0.72rem; color: var(--dim); }
  .img-wrap { display: flex; justify-content: center; padding: 12px; }
  .img-wrap img { max-width: 100%; height: auto; }
  .video-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 8px;
    box-sizing: border-box;
    background: var(--code-bg);
  }
  .video-wrap video { max-width: 100%; max-height: 100%; }
  .pv-notice { font-size: 0.7rem; color: var(--amber); padding: 6px 10px; }
  .codewrap { display: flex; align-items: flex-start; padding: 8px 4px; font-size: 0.72rem; line-height: 1.5; font-family: var(--font-mono); }
  .gutter { flex: 0 0 auto; text-align: right; padding-right: 1em; color: var(--code-gutter); user-select: none; }
  .gutter .ln { min-width: 2.2em; }
  .code { margin: 0; white-space: pre; }
  .code code { font: inherit; }
  .diff { padding: 8px 4px; font-size: 0.72rem; line-height: 1.5; font-family: var(--font-mono); }
  .hh { color: var(--amber); margin: 6px 0 2px; }
  .dl { white-space: pre; }
  .dl.add { color: var(--ok); }
  .dl.del { color: var(--red); }
  .dl.ctx { color: var(--code-gutter); }
  .sign { display: inline-block; width: 1em; user-select: none; }

  /* 尺寸档位按钮：与其他 .pv-btn 同高，宽度随文案自适应 */
  .wbtn { min-width: auto; padding: 0 8px; font-size: 0.7rem; white-space: nowrap; }

  /* 尺寸选择层：形态与 GitReview 的基线选择层一致（底部弹出、同圆角与阴影）。
     只有三项，不限高不滚动。 */
  .wp-mask { position: fixed; inset: 0; z-index: 61; background: var(--overlay-bg); border: 0; }
  .wpick {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 62;
    display: flex; flex-direction: column;
    background: var(--menu-bg);
    border-top: 1px solid var(--line-strong);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    box-shadow: var(--pop-shadow);
    padding: 8px 0 max(8px, env(safe-area-inset-bottom));
    animation: wp-up 0.16s ease-out;
  }
  @keyframes wp-up { from { transform: translateY(12px); opacity: 0.4; } to { transform: none; opacity: 1; } }
  .wp-title {
    font-family: var(--font-mono);
    font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--dimmer); font-weight: 600; padding: 4px 14px 8px;
  }
  .wp-item {
    display: block; width: 100%; text-align: left;
    background: transparent; border: 0; padding: 11px 14px;
    font-size: 0.75rem; color: var(--text);
  }
  .wp-item:active { background: var(--keyhi); }
  .wp-item.on { color: var(--accent); }
  .wp-sub { color: var(--dim); font-size: 0.66rem; }
  .mono { font-family: var(--font-mono); }

  /* 前庭障碍用户把动画全关掉，只留静态弹层 */
  @media (prefers-reduced-motion: reduce) {
    .wpick { animation: none; }
  }
</style>
