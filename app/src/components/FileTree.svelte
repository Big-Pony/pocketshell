<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import { Connection } from "../lib/connection";
  import {
    loadProjectRoot, saveProjectRoot, clearProjectRoot,
    loadRootHistory, pushRootHistory, loadRootFollow, saveRootFollow,
    toFileNodes, setChildren, collapse, filterTree, collectExpandedPaths, type FileNode
  } from "../lib/file-tree";
  import { getBrowseCache, setBrowseCache } from "../lib/file-tree-cache";
  import { IDLE, press, type ArmState } from "../lib/confirm-armed";
  import ContextMenu from "./ContextMenu.svelte";
  import UploadDialog from "./UploadDialog.svelte";
  import { downloadFileBlob, triggerBrowserDownload, downloadFolder, baseName, MAX_TRANSFER_BYTES } from "../lib/transfer";

  let { conn, onOpenFile, onCd, getFocusedPwd, rootTick, onToast, onRefresh, onNewFile }: {
    conn: Connection; onOpenFile: (path: string) => void; onCd: (path: string) => void;
    getFocusedPwd: () => Promise<{ pwd: string } | { error: string }>;
    rootTick: number;
    onToast: (msg: string) => void;
    onRefresh?: () => void;
    onNewFile?: (dir: string, name: string) => void;
  } = $props();

  const cached0 = getBrowseCache();
  let root = $state(cached0.root);
  let nodes = $state<FileNode[]>(cached0.nodes);
  let query = $state(cached0.query);
  let treeEl = $state<HTMLElement | null>(null);
  let notice = $state("");
  let menuFor = $state<FileNode | null>(null);
  let menuAnchor = $state<HTMLElement | undefined>();
  let confirmDel = $state<FileNode | null>(null);
  let arm = $state<ArmState>(IDLE);
  let uploadDir = $state<string | null>(null);
  let newFileDir = $state<string | null>(null);
  let newFileName = $state("");
  function openNewFile(n: FileNode) { newFileDir = n.path; newFileName = ""; }
  function submitNewFile() {
    const name = newFileName.trim();
    if (!newFileDir || !name) return;
    onNewFile?.(newFileDir, name);
    newFileDir = null;
  }
  let archiving = $state(false);
  let historyOpen = $state(false);
  let historyList = $state<string[]>([]);
  let historyDlg = $state<HTMLElement | null>(null);
  function openHistory() { historyList = loadRootHistory(); historyOpen = true; }
  $effect(() => { if (historyOpen && historyDlg) historyDlg.focus(); });

  let following = $state(loadRootFollow());
  let anchorTapTimer: ReturnType<typeof setTimeout> | null = null;

  async function setRootFromFocus() {
    const r = await getFocusedPwd();
    if ("error" in r) { onToast(r.error); return; }
    applyRoot(r.pwd);
    onToast(tr("filetree.toast.rootSet", { path: r.pwd }));
  }
  async function toggleFollow() {
    const next = !following;
    if (next) {
      const r = await getFocusedPwd();
      if ("error" in r) { onToast(tr("filetree.toast.noActiveTerm")); return; }
      applyRoot(r.pwd);
    }
    following = next;
    saveRootFollow(next);
    onToast(next ? tr("filetree.toast.followOn") : tr("filetree.toast.followOff"));
  }
  // Single tap sets root once; double tap toggles follow (cancels the pending single).
  function onAnchorPointer() {
    if (anchorTapTimer) { clearTimeout(anchorTapTimer); anchorTapTimer = null; void toggleFollow(); return; }
    anchorTapTimer = setTimeout(() => { anchorTapTimer = null; void setRootFromFocus(); }, 230);
  }

  // React to App bumping rootTick (follow re-pointed the bookmark): re-read + reload.
  let lastTick = -1;
  $effect(() => {
    const tick = rootTick;
    if (tick === lastTick) return;
    lastTick = tick;
    if (tick === 0) return; // initial mount, nothing to reload
    const r = loadProjectRoot();
    if (r !== root) { root = r; nodes = []; resetScroll(); void loadRoot(); }
  });

  async function doDownloadFile(n: FileNode) {
    try {
      const blob = await downloadFileBlob(conn, n.path);
      triggerBrowserDownload(blob, n.name);
    } catch (e: any) { notice = e?.message ?? tr("filetree.error.download"); }
  }
  async function doDownloadDir(n: FileNode) {
    try { await downloadFolder(conn, n.path, { onArchiving: (b) => (archiving = b) }); }
    catch (e: any) { notice = e?.message ?? tr("filetree.error.downloadDir"); }
  }

  const view = $derived(filterTree(nodes, query));

  async function loadLevel(path: string): Promise<FileNode[]> {
    const r = (await conn.rpc("fs.tree", { path })) as { path: string; nodes: any[]; truncated?: boolean };
    if (r.truncated) notice = tr("filetree.notice.truncated");
    return toFileNodes(path, r.nodes);
  }

  // Display name for the synthetic root node (keep "/" as-is, else basename).
  function rootLabel(p: string): string {
    return p === "/" ? "/" : p.slice(p.lastIndexOf("/") + 1);
  }

  async function loadRoot() {
    notice = "";
    try {
      const kids = await loadLevel(root);
      nodes = [{ name: rootLabel(root), path: root, type: "dir", expanded: true, children: kids, hasChildren: kids.length > 0 }];
    } catch (e: any) { notice = e?.message ?? tr("filetree.error.load"); nodes = []; }
  }

  // Refresh the tree in place: re-fetch the root level and every level that was
  // expanded, keeping the same expansion so newly-created files (e.g. from AI)
  // appear without collapsing the user's view.
  async function reloadKeepingExpanded() {
    notice = "";
    const expanded = collectExpandedPaths(nodes);
    const rebuild = async (path: string): Promise<FileNode[]> => {
      const kids = await loadLevel(path);
      for (const k of kids) {
        if (k.type === "dir" && expanded.has(k.path)) {
          k.expanded = true;
          k.children = await rebuild(k.path);
          k.hasChildren = k.children.length > 0;
        }
      }
      return kids;
    };
    try {
      const kids = await rebuild(root);
      nodes = [{ name: rootLabel(root), path: root, type: "dir", expanded: true, children: kids, hasChildren: kids.length > 0 }];
      onRefresh?.();
    } catch (e: any) { notice = e?.message ?? tr("filetree.error.refresh"); }
  }

  async function toggle(n: FileNode) {
    if (n.type === "file") { onOpenFile(n.path); return; }
    if (n.expanded) { nodes = collapse(nodes, n.path); return; }
    try { nodes = setChildren(nodes, n.path, await loadLevel(n.path)); }
    catch (e: any) { notice = e?.message ?? tr("filetree.error.load"); }
  }

  function openMenu(n: FileNode, anchor: HTMLElement) {
    menuFor = n;
    menuAnchor = anchor;
  }

  function parentOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i <= 0 ? "/" : path.slice(0, i);
  }
  async function refreshParent(path: string) {
    const parent = parentOf(path);
    try {
      const kids = await loadLevel(parent);
      if (parent === root) {
        nodes = nodes.map((n) => n.path === root ? { ...n, children: kids, hasChildren: kids.length > 0 } : n);
      } else {
        nodes = setChildren(nodes, parent, kids);
      }
    } catch (e: any) { notice = e?.message ?? tr("filetree.error.refresh"); }
  }

  function childPath(parent: string, name: string): string {
    return parent === "/" ? "/" + name : parent + "/" + name;
  }
  async function doRename(n: FileNode) {
    const next = prompt(tr("filetree.prompt.rename"), n.name);
    if (!next || !next.trim() || next.trim() === n.name) return;
    const to = childPath(parentOf(n.path), next.trim());
    try { await conn.rpc("fs.op", { op: "rename", path: n.path, to }); await refreshParent(n.path); }
    catch (e: any) { notice = e?.message ?? tr("filetree.error.rename"); }
  }
  async function doMkdir(n: FileNode) {
    const name = prompt(tr("filetree.prompt.mkdir"), "");
    if (!name || !name.trim()) return;
    try { await conn.rpc("fs.op", { op: "mkdir", path: childPath(n.path, name.trim()) }); await refreshParent(childPath(n.path, "x")); }
    catch (e: any) { notice = e?.message ?? tr("filetree.error.create"); }
  }
  async function confirmDelete(n: FileNode, now: number) {
    const r = press(arm, now);
    arm = r.state;
    if (!r.fire) return;
    confirmDel = null;
    try { await conn.rpc("fs.op", { op: "delete", path: n.path }); await refreshParent(n.path); }
    catch (e: any) { notice = e?.message ?? tr("filetree.error.delete"); }
  }
  function resetScroll() {
    setBrowseCache({ scrollTop: 0 });
    if (treeEl) treeEl.scrollTop = 0;
  }
  function applyRoot(path: string) {
    saveProjectRoot(path);
    pushRootHistory(path);
    root = path;
    nodes = [];
    resetScroll();
    void loadRoot();
    onRefresh?.();
  }
  function setRoot(n: FileNode) { applyRoot(n.path); }
  function unsetRoot() {
    clearProjectRoot();
    root = "/";
    nodes = [];
    resetScroll();
    void loadRoot();
    onRefresh?.();
  }

  function flatten(list: FileNode[], depth = 0): { n: FileNode; depth: number }[] {
    const out: { n: FileNode; depth: number }[] = [];
    for (const n of list) {
      out.push({ n, depth });
      if (n.expanded && n.children) out.push(...flatten(n.children, depth + 1));
    }
    return out;
  }
  const rows = $derived(flatten(view));

  // Persist browse state to the module cache on every change so a remount (panel
  // switch / fullscreen toggle) can restore it verbatim.
  $effect(() => { setBrowseCache({ root, nodes, query }); });

  // First mount does the fs.tree load; later remounts reuse the cached tree (no
  // request, no flicker) and just restore the scroll position. onMount runs once
  // per mount (not reactively), so there is no fs.tree storm risk.
  onMount(async () => {
    if (getBrowseCache().loaded && nodes.length) {
      await tick();
      if (treeEl) treeEl.scrollTop = getBrowseCache().scrollTop;
      return;
    }
    await loadRoot();
    setBrowseCache({ loaded: true });
  });

  // Save the scroll position on every genuine scroll. Capture the value into a
  // closure variable immediately so a rapid panel switch can still flush the last
  // known position during onDestroy (the element's live scrollTop may be 0 by then).
  let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
  let destroying = false;
  let lastScrollTop = 0;
  function onScroll() {
    if (!treeEl || destroying) return;
    lastScrollTop = treeEl.scrollTop;
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      if (treeEl && !destroying) setBrowseCache({ scrollTop: treeEl.scrollTop });
    }, 150);
  }
  onDestroy(() => {
    destroying = true;
    if (scrollTimeout) clearTimeout(scrollTimeout);
    setBrowseCache({ scrollTop: lastScrollTop });
  });
</script>

<div class="ft">
  <div class="pathbar">
    <button class="root-anchor" class:on={following} aria-label={$t('filetree.aria.anchor')}
      onpointerdown={onAnchorPointer}><span class="ring"></span></button>
    <span class="path-text mono">{root}</span>
    <button class="root-switch" aria-label={$t('filetree.aria.switchRoot')} onclick={openHistory}>⇄</button>
    <button class="root-refresh" aria-label={$t('filetree.aria.refresh')} onclick={reloadKeepingExpanded}>⟳</button>
  </div>
  <input class="filter" bind:value={query} placeholder={$t('filetree.filterPh')} />
  {#if notice}<div class="ft-notice">{notice}</div>{/if}
  <ul class="tree" bind:this={treeEl} onscroll={onScroll}>
    {#each rows as { n, depth } (n.path)}
      <li class="row-wrap">
        <button class="row" style="padding-left: {6 + depth * 14}px"
          onclick={() => toggle(n)}>
          <span class="tw">{n.type === "dir" ? (n.expanded ? "▾" : "▸") : "·"}</span>
          <span class="nm">{n.name}</span>
          {#if n.git}<span class="g g-{n.git}">{n.git}</span>{/if}
        </button>
        <button class="more" aria-label={$t('common.more')}
          onclick={(e) => { e.stopPropagation(); openMenu(n, e.currentTarget); }}>⋯</button>
      </li>
    {/each}
  </ul>

  {#if menuFor}
    {#if menuFor.type === "dir"}
      <ContextMenu onClose={() => (menuFor = null)} anchor={menuAnchor} items={[
        { label: $t('filetree.menu.setRoot'), icon: "◎", onSelect: () => setRoot(menuFor!) },
        ...(menuFor.path === root ? [{ label: $t('filetree.menu.unsetRoot'), icon: "⊘", onSelect: unsetRoot }] : []),
        { label: $t('filetree.menu.copyPath'), icon: "📋", onSelect: () => navigator.clipboard?.writeText(menuFor!.path) },
        { label: $t('filetree.menu.cd'), icon: "⌘", onSelect: () => onCd(menuFor!.path) },
        { label: $t('filetree.menu.rename'), icon: "✎", onSelect: () => doRename(menuFor!) },
        { label: $t('filetree.menu.mkdir'), icon: "＋", onSelect: () => doMkdir(menuFor!) },
        { label: $t('filetree.menu.newFile'), icon: "⊕", onSelect: () => openNewFile(menuFor!) },
        { label: $t('filetree.menu.upload'), icon: "⬆", onSelect: () => { uploadDir = menuFor!.path; } },
        { label: $t('filetree.menu.download'), icon: "⬇", onSelect: () => doDownloadDir(menuFor!) },
        { label: $t('filetree.menu.delete'), icon: "🗑", danger: true, onSelect: () => { confirmDel = menuFor; arm = IDLE; } },
      ]} />
    {:else}
      <ContextMenu onClose={() => (menuFor = null)} anchor={menuAnchor} items={[
        { label: $t('filetree.menu.openPreview'), icon: "▤", onSelect: () => onOpenFile(menuFor!.path) },
        { label: $t('filetree.menu.copyPath'), icon: "📋", onSelect: () => navigator.clipboard?.writeText(menuFor!.path) },
        { label: $t('filetree.menu.download'), icon: "⬇", onSelect: () => doDownloadFile(menuFor!) },
        { label: $t('filetree.menu.rename'), icon: "✎", onSelect: () => doRename(menuFor!) },
        { label: $t('filetree.menu.delete'), icon: "🗑", danger: true, onSelect: () => { confirmDel = menuFor; arm = IDLE; } },
      ]} />
    {/if}
  {/if}

  {#if uploadDir}
    <UploadDialog {conn} dir={uploadDir}
      onClose={() => (uploadDir = null)}
      onUploaded={(d) => { uploadDir = null; void refreshParent(childPath(d, "x")); }} />
  {/if}

  {#if newFileDir}
    <div class="confirm-overlay" role="presentation" onclick={() => (newFileDir = null)}>
      <div class="confirm-dlg" role="dialog" aria-modal="true" aria-labelledby="newfile-title" tabindex="-1"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && (newFileDir = null)}>
        <div class="dlg-title" id="newfile-title">{$t('filetree.newfile.title')}</div>
        <div class="dlg-path mono">{newFileDir}</div>
        <input class="nf-input mono" placeholder={$t('filetree.newfile.ph')} bind:value={newFileName}
          onkeydown={(e) => { if (e.key === 'Enter') submitNewFile(); if (e.key === 'Escape') newFileDir = null; }} />
        <div class="dlg-btns">
          <button onclick={() => (newFileDir = null)}>{$t('common.cancel')}</button>
          <button class="ok" disabled={!newFileName.trim()} onclick={submitNewFile}>{$t('common.confirm')}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if archiving}
    <div class="arch-overlay" role="status" aria-label={$t('filetree.archivingAria')}>
      <div class="spinner"></div>
      <div class="arch-txt">{$t('filetree.archiving')}</div>
    </div>
  {/if}

  {#if confirmDel}
    <div class="confirm-overlay" role="dialog" aria-modal="true">
      <div class="confirm-dlg">
        <div class="dlg-title">{$t('filetree.del.title')}</div>
        <div class="dlg-path mono">{confirmDel.path}</div>
        <div class="dlg-hint">{$t('filetree.del.hint')}</div>
        <div class="dlg-btns">
          <button onclick={() => (confirmDel = null)}>{$t('common.cancel')}</button>
          <button class="danger" class:armed={arm.armed} onclick={(e) => confirmDelete(confirmDel, e.timeStamp)}>
            {arm.armed ? $t('filetree.del.armed') : $t('filetree.del.ok')}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if historyOpen}
    <div class="confirm-overlay" role="presentation"
      onclick={() => (historyOpen = false)}>
      <div class="confirm-dlg" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="history-title"
        bind:this={historyDlg}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && (historyOpen = false)}>
        <div class="dlg-title" id="history-title">{$t('filetree.history.title')}</div>
        {#if historyList.length === 0}
          <div class="hist-empty">{$t('filetree.history.empty')}</div>
        {:else}
          <ul class="hist-list">
            {#each historyList as p (p)}
              <li>
                <button class="hist-item mono" class:cur={p === root} disabled={p === root}
                  onclick={() => { applyRoot(p); historyOpen = false; }}>{p}</button>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="dlg-btns">
          <button onclick={() => (historyOpen = false)}>{$t('common.cancel')}</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .ft { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
  .pathbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; }
  .root-switch, .root-refresh { flex: 0 0 auto; background: var(--panel2); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-md); padding: 2px 9px; font-size: 0.8rem; line-height: 1.4; }
  .root-switch:active, .root-refresh:active { background: var(--key); }
  .path-text { flex: 1; min-width: 0; font-size: 0.68rem; color: var(--dim); overflow-x: auto; white-space: nowrap; }
  .root-anchor { flex: 0 0 auto; background: var(--panel2); border: 1px solid var(--line); border-radius: 50%; width: 26px; height: 26px; display: grid; place-items: center; padding: 0; }
  .root-anchor .ring { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--dim); display: grid; place-items: center; }
  .root-anchor .ring::after { content: ""; width: 4px; height: 4px; border-radius: 50%; background: var(--dim); }
  .root-anchor.on { border-color: var(--accent); }
  .root-anchor.on .ring { border-color: var(--accent); }
  .root-anchor.on .ring::after { background: var(--accent); }
  .filter { margin: 0 8px 6px; background: var(--panel2); border: 1px solid var(--line); border-radius: var(--radius-md); color: var(--text); padding: 6px 8px; font-size: 0.72rem; }
  .ft-notice { font-size: 0.68rem; color: var(--amber); padding: 2px 10px; }
  .tree { list-style: none; margin: 0; padding: 0 8px 8px; overflow-y: auto; flex: 1; min-height: 0; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
  .row-wrap { display: flex; align-items: center; width: 100%; }
  .row { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text); text-align: left; padding: 7px 6px; font-size: 0.74rem; }
  .row:active { background: var(--panel); }
  .more { flex: 0 0 auto; background: transparent; border: 0; color: var(--dim); padding: 0 6px; font-size: 1rem; line-height: 1; }
  .more:active { color: var(--text); }
  .tw { width: 1em; color: var(--dim); }
  .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .g { font-size: 0.6rem; font-weight: 700; }
  .g-M { color: var(--amber); } .g-A { color: var(--ok); } .g-D { color: var(--red); } .g-\? { color: var(--dim); }

  .confirm-overlay {
    position: fixed; inset: 0; z-index: 40;
    background: var(--overlay-bg);
    display: grid; place-items: center;
  }
  .confirm-dlg {
    background: var(--dlg-bg); border: 1px solid var(--line);
    border-radius: var(--radius-xl); padding: 20px;
    width: min(280px, 80vw); text-align: center;
    box-shadow: var(--pop-shadow);
  }
  .dlg-title { font-size: 0.85rem; font-weight: 700; margin-bottom: 6px; }
  .dlg-path { font-size: 0.7rem; color: var(--text); margin-bottom: 6px; word-break: break-all; }
  .dlg-hint { font-size: 0.68rem; color: var(--amber); margin-bottom: 16px; }
  .dlg-btns { display: flex; gap: 8px; }
  .dlg-btns button { flex: 1; padding: 9px 0; border-radius: var(--radius-md); border: 1px solid var(--line); font-size: 0.75rem; background: var(--key); color: var(--text); }
  .dlg-btns button.danger { background: var(--red); color: #fff; border-color: transparent; }
  .dlg-btns button.danger.armed { outline: 2px solid var(--amber); }
  .nf-input { width: 100%; box-sizing: border-box; margin-bottom: 14px; background: var(--panel2); border: 1px solid var(--line); border-radius: var(--radius-md); color: var(--text); padding: 8px 10px; font-size: 0.75rem; }
  .dlg-btns button.ok { background: var(--primary-bg); color: var(--primary-text); border-color: transparent; font-weight: 700; }
  .dlg-btns button.ok:disabled { opacity: 0.5; }

  .arch-overlay { position: fixed; inset: 0; z-index: 40; background: var(--overlay-bg); display: grid; place-items: center; gap: 10px; }
  .arch-overlay .arch-txt { color: var(--text); font-size: 0.75rem; text-align: center; }
  .spinner { width: 34px; height: 34px; border: 3px solid var(--line); border-top-color: var(--accent); border-radius: 50%; margin: 0 auto; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .hist-list { list-style: none; margin: 0 0 14px; padding: 0; max-height: 44vh; overflow-y: auto; text-align: left; }
  .hist-list li { margin-bottom: 5px; }
  .hist-item { width: 100%; text-align: left; background: var(--panel2); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-md); padding: 8px 10px; font-size: 0.7rem; word-break: break-all; }
  .hist-item.cur { border-color: var(--accent); color: var(--accent-text); }
  .hist-item:disabled { opacity: 0.7; }
  .hist-empty { color: var(--dim); font-size: 0.72rem; margin-bottom: 14px; }
</style>
