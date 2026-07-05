<script lang="ts">
  import { Connection } from "../lib/connection";
  import {
    loadProjectRoot, saveProjectRoot, clearProjectRoot,
    toFileNodes, setChildren, collapse, filterTree, type FileNode
  } from "../lib/file-tree";
  import { IDLE, press, type ArmState } from "../lib/confirm-armed";
  import ContextMenu from "./ContextMenu.svelte";

  let { conn, onOpenFile, onCd }: {
    conn: Connection; onOpenFile: (path: string) => void; onCd: (path: string) => void;
  } = $props();

  let root = $state(loadProjectRoot());
  let nodes = $state<FileNode[]>([]);
  let query = $state("");
  let notice = $state("");
  let menuFor = $state<FileNode | null>(null);
  let menuAnchor = $state<HTMLElement | undefined>();
  let confirmDel = $state<FileNode | null>(null);
  let arm = $state<ArmState>(IDLE);

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
  function setRoot(n: FileNode) {
    saveProjectRoot(n.path);
    root = n.path;
    nodes = [];
    void loadRoot();
  }
  function unsetRoot() {
    clearProjectRoot();
    root = "/";
    nodes = [];
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

  // Load the root once on mount. A guard flag (not `!nodes.length`) is required:
  // loadRoot's catch resets nodes=[], and setRoot/unsetRoot also clear it, so an
  // `!nodes.length` effect would re-fire forever on a bad/deleted root or an
  // offline rpc reject — an unbounded fs.tree storm. setRoot/unsetRoot call
  // loadRoot() themselves, so the effect only needs to cover the initial mount.
  let didLoad = false;
  $effect(() => { if (!didLoad) { didLoad = true; void loadRoot(); } });
</script>

<div class="ft">
  <div class="pathbar mono">{root}</div>
  <input class="filter" bind:value={query} placeholder="过滤当前已加载节点…" />
  {#if notice}<div class="ft-notice">{notice}</div>{/if}
  <ul class="tree">
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
        { label: "删除", icon: "🗑", danger: true, onSelect: () => { confirmDel = menuFor; arm = IDLE; } },
      ]} />
    {:else}
      <ContextMenu onClose={() => (menuFor = null)} anchor={menuAnchor} items={[
        { label: "打开预览", icon: "▤", onSelect: () => onOpenFile(menuFor!.path) },
        { label: "复制路径", icon: "📋", onSelect: () => navigator.clipboard?.writeText(menuFor!.path) },
        { label: "重命名", icon: "✎", onSelect: () => doRename(menuFor!) },
        { label: "删除", icon: "🗑", danger: true, onSelect: () => { confirmDel = menuFor; arm = IDLE; } },
      ]} />
    {/if}
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
</div>

<style>
  .ft { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
  .pathbar { font-size: 0.68rem; color: var(--dim); padding: 6px 10px; overflow-x: auto; white-space: nowrap; }
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
</style>
