<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import { Connection } from "../lib/connection";
  import { toFileNodes, setChildren, collapse, type FileNode } from "../lib/file-tree";

  let { conn, rootDir, currentPath, open, onSelect, onClose }: {
    conn: Connection; rootDir: string; currentPath: string; open: boolean;
    onSelect: (p: string) => void; onClose: () => void;
  } = $props();

  let nodes = $state<FileNode[]>([]);
  let notice = $state("");

  async function loadLevel(path: string): Promise<FileNode[]> {
    const r = (await conn.rpc("fs.tree", { path })) as { path: string; nodes: any[]; truncated?: boolean };
    if (r.truncated) notice = tr("filetree.notice.truncated");
    return toFileNodes(path, r.nodes);
  }

  async function loadRoot() {
    notice = "";
    try { nodes = await loadLevel(rootDir); }
    catch { notice = tr("preview.dirLoadFailed"); nodes = []; }
  }

  async function toggle(n: FileNode) {
    if (n.type === "file") { onSelect(n.path); return; }
    if (n.expanded) { nodes = collapse(nodes, n.path); return; }
    try { nodes = setChildren(nodes, n.path, await loadLevel(n.path)); }
    catch { notice = tr("preview.dirLoadFailed"); }
  }

  function flatten(list: FileNode[], depth = 0): { n: FileNode; depth: number }[] {
    const out: { n: FileNode; depth: number }[] = [];
    for (const n of list) {
      out.push({ n, depth });
      if (n.expanded && n.children) out.push(...flatten(n.children, depth + 1));
    }
    return out;
  }
  const rows = $derived(flatten(nodes));

  onMount(loadRoot);
</script>

<div class="drawer" class:open aria-hidden={!open}>
  <div class="backdrop" role="presentation" onclick={onClose}></div>
  <nav class="panel" aria-label={$t('preview.dir')}>
    <div class="dhead">
      <span class="dtitle">{$t('preview.dir')}</span>
      <button class="dclose" aria-label={$t('preview.exitFullscreen')} onclick={onClose}>✕</button>
    </div>
    {#if notice}<div class="dnotice">{notice}</div>{/if}
    {#if rows.length === 0 && !notice}<div class="dempty">{$t('preview.dirEmpty')}</div>{/if}
    <ul class="tree">
      {#each rows as { n, depth } (n.path)}
        <li>
          <button class="row" class:cur={n.path === currentPath} style="padding-left: {6 + depth * 14}px"
            onclick={() => toggle(n)}>
            <span class="tw">{n.type === "dir" ? (n.expanded ? "▾" : "▸") : "·"}</span>
            <span class="nm">{n.name}</span>
            {#if n.git}<span class="g g-{n.git}">{n.git}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  </nav>
</div>

<style>
  /* 覆盖在 .preview.fs (z60) 内部，滑入抽屉盖住预览内容 */
  .drawer { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
  .drawer.open { pointer-events: auto; }
  .backdrop { position: absolute; inset: 0; background: var(--overlay-bg); opacity: 0; transition: opacity 0.18s ease; }
  .drawer.open .backdrop { opacity: 1; }
  .panel {
    position: absolute; top: 0; left: 0; bottom: 0; width: min(76%, 300px);
    display: flex; flex-direction: column;
    background: var(--panel); border-right: 1px solid var(--line);
    transform: translateX(-100%); transition: transform 0.18s ease;
  }
  .drawer.open .panel { transform: translateX(0); }
  .dhead { display: flex; align-items: center; height: 40px; padding: 0 10px; border-bottom: 1px solid var(--line); flex: 0 0 auto; }
  .dtitle { flex: 1; font-size: 0.78rem; color: var(--text); font-weight: 600; }
  .dclose { background: transparent; border: 0; color: var(--dim); font-size: 0.9rem; padding: 4px 8px; }
  .dclose:active { color: var(--text); }
  .dnotice { font-size: 0.68rem; color: var(--amber); padding: 6px 10px; }
  .dempty { font-size: 0.72rem; color: var(--dim); padding: 10px; }
  .tree { list-style: none; margin: 0; padding: 4px 6px 10px; overflow-y: auto; flex: 1; min-height: 0; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
  .row { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: transparent; color: var(--text); text-align: left; padding: 8px 6px; font-size: 0.74rem; border-radius: var(--radius-md, 8px); }
  .row:active { background: var(--panel2); }
  .row.cur { background: var(--primary-bg); color: var(--primary-text); }
  .tw { width: 1em; color: var(--dim); flex: 0 0 auto; }
  .row.cur .tw { color: inherit; }
  .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .g { font-size: 0.6rem; font-weight: 700; flex: 0 0 auto; }
  .g-M { color: var(--amber); } .g-A { color: var(--ok); } .g-D { color: var(--red); } .g-\? { color: var(--dim); }
</style>
