<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { Connection } from "../lib/connection";
  import {
    loadProjectRoot, saveProjectRoot, clearProjectRoot,
    loadRootHistory, pushRootHistory, loadRootFollow, saveRootFollow,
    toFileNodes, setChildren, collapse, filterTree, type FileNode
  } from "../lib/file-tree";
  import { getBrowseCache, setBrowseCache } from "../lib/file-tree-cache";
  import { IDLE, press, type ArmState } from "../lib/confirm-armed";
  import ContextMenu from "./ContextMenu.svelte";
  import UploadDialog from "./UploadDialog.svelte";
  import { downloadFileBlob, triggerBrowserDownload, downloadFolder, baseName, MAX_TRANSFER_BYTES } from "../lib/transfer";

  let { conn, onOpenFile, onCd, getFocusedPwd, rootTick, onToast }: {
    conn: Connection; onOpenFile: (path: string) => void; onCd: (path: string) => void;
    getFocusedPwd: () => Promise<{ pwd: string } | { error: string }>;
    rootTick: number;
    onToast: (msg: string) => void;
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
    onToast("项目根已设为 " + r.pwd);
  }
  async function toggleFollow() {
    const next = !following;
    if (next) {
      const r = await getFocusedPwd();
      if ("error" in r) { onToast("没有活跃终端，无法绑定项目根跟随"); return; }
      applyRoot(r.pwd);
    }
    following = next;
    saveRootFollow(next);
    onToast(next ? "项目根开始跟随聚焦终端" : "已取消项目根跟随");
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
    } catch (e: any) { notice = e?.message ?? "下载失败"; }
  }
  async function doDownloadDir(n: FileNode) {
    try { await downloadFolder(conn, n.path, { onArchiving: (b) => (archiving = b) }); }
    catch (e: any) { notice = e?.message ?? "打包下载失败"; }
  }

  const view = $derived(filterTree(nodes, query));

  async function loadLevel(path: string): Promise<FileNode[]> {
    const r = (await conn.rpc("fs.tree", { path })) as { path: string; nodes: any[]; truncated?: boolean };
    if (r.truncated) notice = "目录过大，仅显示前 500 项";
    return toFileNodes(path, r.nodes);
  }

  async function loadRoot() {
    notice = "";
    try {
      const kids = await loadLevel(root);
      const rootName = root === "/" ? "/" : root.slice(root.lastIndexOf("/") + 1);
      nodes = [{ name: rootName, path: root, type: "dir", expanded: true, children: kids, hasChildren: kids.length > 0 }];
    } catch (e: any) { notice = e?.message ?? "加载失败"; nodes = []; }
  }

  async function toggle(n: FileNode) {
    if (n.type === "file") { onOpenFile(n.path); return; }
    if (n.expanded) { nodes = collapse(nodes, n.path); return; }
    try { nodes = setChildren(nodes, n.path, await loadLevel(n.path)); }
    catch (e: any) { notice = e?.message ?? "加载失败"; }
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
    } catch (e: any) { notice = e?.message ?? "刷新失败"; }
  }

  function childPath(parent: string, name: string): string {
    return parent === "/" ? "/" + name : parent + "/" + name;
  }
  async function doRename(n: FileNode) {
    const next = prompt("重命名为", n.name);
    if (!next || !next.trim() || next.trim() === n.name) return;
    const to = childPath(parentOf(n.path), next.trim());
    try { await conn.rpc("fs.op", { op: "rename", path: n.path, to }); await refreshParent(n.path); }
    catch (e: any) { notice = e?.message ?? "重命名失败"; }
  }
  async function doMkdir(n: FileNode) {
    const name = prompt("新建目录名", "");
    if (!name || !name.trim()) return;
    try { await conn.rpc("fs.op", { op: "mkdir", path: childPath(n.path, name.trim()) }); await refreshParent(childPath(n.path, "x")); }
    catch (e: any) { notice = e?.message ?? "新建失败"; }
  }
  async function confirmDelete(n: FileNode, now: number) {
    const r = press(arm, now);
    arm = r.state;
    if (!r.fire) return;
    confirmDel = null;
    try { await conn.rpc("fs.op", { op: "delete", path: n.path }); await refreshParent(n.path); }
    catch (e: any) { notice = e?.message ?? "删除失败"; }
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
  }
  function setRoot(n: FileNode) { applyRoot(n.path); }
  function unsetRoot() {
    clearProjectRoot();
    root = "/";
    nodes = [];
    resetScroll();
    void loadRoot();
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
    <button class="root-anchor" class:on={following} aria-label="设为/跟随项目根"
      onpointerdown={onAnchorPointer}><span class="ring"></span></button>
    <span class="path-text mono">{root}</span>
    <button class="root-switch" aria-label="切换项目根" onclick={openHistory}>⇄</button>
  </div>
  <input class="filter" bind:value={query} placeholder="过滤当前已加载节点…" />
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
        <button class="more" aria-label="更多"
          onclick={(e) => { e.stopPropagation(); openMenu(n, e.currentTarget); }}>⋯</button>
      </li>
    {/each}
  </ul>

  {#if menuFor}
    {#if menuFor.type === "dir"}
      <ContextMenu onClose={() => (menuFor = null)} anchor={menuAnchor} items={[
        { label: "设为项目根", icon: "◎", onSelect: () => setRoot(menuFor!) },
        ...(menuFor.path === root ? [{ label: "取消根目录绑定", icon: "⊘", onSelect: unsetRoot }] : []),
        { label: "复制路径", icon: "📋", onSelect: () => navigator.clipboard?.writeText(menuFor!.path) },
        { label: "cd 到此处", icon: "⌘", onSelect: () => onCd(menuFor!.path) },
        { label: "重命名", icon: "✎", onSelect: () => doRename(menuFor!) },
        { label: "新建目录", icon: "＋", onSelect: () => doMkdir(menuFor!) },
        { label: "上传文件", icon: "⬆", onSelect: () => { uploadDir = menuFor!.path; } },
        { label: "下载", icon: "⬇", onSelect: () => doDownloadDir(menuFor!) },
        { label: "删除", icon: "🗑", danger: true, onSelect: () => { confirmDel = menuFor; arm = IDLE; } },
      ]} />
    {:else}
      <ContextMenu onClose={() => (menuFor = null)} anchor={menuAnchor} items={[
        { label: "打开预览", icon: "▤", onSelect: () => onOpenFile(menuFor!.path) },
        { label: "复制路径", icon: "📋", onSelect: () => navigator.clipboard?.writeText(menuFor!.path) },
        { label: "下载", icon: "⬇", onSelect: () => doDownloadFile(menuFor!) },
        { label: "重命名", icon: "✎", onSelect: () => doRename(menuFor!) },
        { label: "删除", icon: "🗑", danger: true, onSelect: () => { confirmDel = menuFor; arm = IDLE; } },
      ]} />
    {/if}
  {/if}

  {#if uploadDir}
    <UploadDialog {conn} dir={uploadDir}
      onClose={() => (uploadDir = null)}
      onUploaded={(d) => { uploadDir = null; void refreshParent(childPath(d, "x")); }} />
  {/if}

  {#if archiving}
    <div class="arch-overlay" role="status" aria-label="打包中">
      <div class="spinner"></div>
      <div class="arch-txt">正在打包…</div>
    </div>
  {/if}

  {#if confirmDel}
    <div class="confirm-overlay" role="dialog" aria-modal="true">
      <div class="confirm-dlg">
        <div class="dlg-title">删除</div>
        <div class="dlg-path mono">{confirmDel.path}</div>
        <div class="dlg-hint">此操作不可撤销 · 连点 2 下确认</div>
        <div class="dlg-btns">
          <button onclick={() => (confirmDel = null)}>取消</button>
          <button class="danger" class:armed={arm.armed} onclick={(e) => confirmDelete(confirmDel, e.timeStamp)}>
            {arm.armed ? "再点一次删除" : "确定"}
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
        <div class="dlg-title" id="history-title">切换项目根</div>
        {#if historyList.length === 0}
          <div class="hist-empty">暂无历史</div>
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
          <button onclick={() => (historyOpen = false)}>取消</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .ft { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
  .pathbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; }
  .root-switch { flex: 0 0 auto; background: var(--panel2); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-md); padding: 2px 9px; font-size: 0.8rem; line-height: 1.4; }
  .root-switch:active { background: var(--key); }
  .path-text { flex: 1; min-width: 0; font-size: 0.68rem; color: var(--dim); overflow-x: auto; white-space: nowrap; }
  .root-anchor { flex: 0 0 auto; background: var(--panel2); border: 1px solid var(--line); border-radius: 50%; width: 26px; height: 26px; display: grid; place-items: center; padding: 0; }
  .root-anchor .ring { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--dim); display: grid; place-items: center; }
  .root-anchor .ring::after { content: ""; width: 4px; height: 4px; border-radius: 50%; background: var(--dim); }
  .root-anchor.on { border-color: var(--teal); }
  .root-anchor.on .ring { border-color: var(--teal); }
  .root-anchor.on .ring::after { background: var(--teal); }
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
  .g-M { color: var(--amber); } .g-A { color: var(--teal); } .g-D { color: var(--red); } .g-\? { color: var(--dim); }

  .confirm-overlay {
    position: fixed; inset: 0; z-index: 40;
    background: rgba(7, 9, 11, 0.75);
    display: grid; place-items: center;
  }
  .confirm-dlg {
    background: #1c2530; border: 1px solid var(--line);
    border-radius: 14px; padding: 20px;
    width: min(280px, 80vw); text-align: center;
  }
  .dlg-title { font-size: 0.85rem; font-weight: 700; margin-bottom: 6px; }
  .dlg-path { font-size: 0.7rem; color: var(--text); margin-bottom: 6px; word-break: break-all; }
  .dlg-hint { font-size: 0.68rem; color: var(--amber); margin-bottom: 16px; }
  .dlg-btns { display: flex; gap: 8px; }
  .dlg-btns button { flex: 1; padding: 9px 0; border-radius: var(--radius-md); border: 1px solid var(--line); font-size: 0.75rem; background: var(--key); color: var(--text); }
  .dlg-btns button.danger { background: var(--red); color: #fff; border-color: transparent; }
  .dlg-btns button.danger.armed { outline: 2px solid var(--amber); }

  .arch-overlay { position: fixed; inset: 0; z-index: 40; background: rgba(7,9,11,0.7); display: grid; place-items: center; gap: 10px; }
  .arch-overlay .arch-txt { color: var(--text); font-size: 0.75rem; text-align: center; }
  .spinner { width: 34px; height: 34px; border: 3px solid var(--line); border-top-color: var(--teal); border-radius: 50%; margin: 0 auto; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .hist-list { list-style: none; margin: 0 0 14px; padding: 0; max-height: 44vh; overflow-y: auto; text-align: left; }
  .hist-list li { margin-bottom: 5px; }
  .hist-item { width: 100%; text-align: left; background: var(--panel2); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-md); padding: 8px 10px; font-size: 0.7rem; word-break: break-all; }
  .hist-item.cur { border-color: var(--teal); color: var(--teal); }
  .hist-item:disabled { opacity: 0.7; }
  .hist-empty { color: var(--dim); font-size: 0.72rem; margin-bottom: 14px; }
</style>
