<script lang="ts">
  import { Connection } from "../lib/connection";
  import { loadProjectRoot, toFileNodes, setChildren, collapse, filterTree, type FileNode } from "../lib/file-tree";

  let { conn, onOpenFile }: { conn: Connection; onOpenFile: (path: string) => void } = $props();

  let root = $state(loadProjectRoot());
  let nodes = $state<FileNode[]>([]);
  let query = $state("");
  let notice = $state("");

  const view = $derived(filterTree(nodes, query));

  async function loadLevel(path: string): Promise<FileNode[]> {
    const r = (await conn.rpc("fs.tree", { path })) as { path: string; nodes: any[]; truncated?: boolean };
    if (r.truncated) notice = "目录过大，仅显示前 500 项";
    return toFileNodes(path, r.nodes);
  }

  async function loadRoot() {
    notice = "";
    try { nodes = await loadLevel(root); }
    catch (e: any) { notice = e?.message ?? "加载失败"; nodes = []; }
  }

  async function toggle(n: FileNode) {
    if (n.type === "file") { onOpenFile(n.path); return; }
    if (n.expanded) { nodes = collapse(nodes, n.path); return; }
    try { nodes = setChildren(nodes, n.path, await loadLevel(n.path)); }
    catch (e: any) { notice = e?.message ?? "加载失败"; }
  }

  // Flatten for rendering with depth (indentation).
  function flatten(list: FileNode[], depth = 0): { n: FileNode; depth: number }[] {
    const out: { n: FileNode; depth: number }[] = [];
    for (const n of list) {
      out.push({ n, depth });
      if (n.expanded && n.children) out.push(...flatten(n.children, depth + 1));
    }
    return out;
  }
  const rows = $derived(flatten(view));

  $effect(() => { if (!nodes.length) void loadRoot(); });
</script>

<div class="ft">
  <div class="pathbar mono">{root}</div>
  <input class="filter" bind:value={query} placeholder="过滤当前已加载节点…" />
  {#if notice}<div class="ft-notice">{notice}</div>{/if}
  <ul class="tree">
    {#each rows as { n, depth } (n.path)}
      <li>
        <button class="row" style="padding-left: {6 + depth * 14}px" onclick={() => toggle(n)}>
          <span class="tw">{n.type === "dir" ? (n.expanded ? "▾" : "▸") : "·"}</span>
          <span class="nm">{n.name}</span>
          {#if n.git}<span class="g g-{n.git}">{n.git}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .ft { display: flex; flex-direction: column; height: 100%; }
  .pathbar { font-size: 0.68rem; color: var(--dim); padding: 6px 10px; overflow-x: auto; white-space: nowrap; }
  .filter { margin: 0 8px 6px; background: var(--panel2); border: 1px solid var(--line); border-radius: var(--radius-md); color: var(--text); padding: 6px 8px; font-size: 0.72rem; }
  .ft-notice { font-size: 0.68rem; color: var(--amber); padding: 2px 10px; }
  .tree { list-style: none; margin: 0; padding: 0 8px 8px; overflow-y: auto; flex: 1; }
  .row { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: transparent; color: var(--text); text-align: left; padding: 7px 6px; font-size: 0.74rem; }
  .row:active { background: var(--panel); }
  .tw { width: 1em; color: var(--dim); }
  .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .g { font-size: 0.6rem; font-weight: 700; }
  .g-M { color: var(--amber); } .g-A { color: var(--teal); } .g-D { color: var(--red); } .g-\? { color: var(--dim); }
</style>
