<script lang="ts">
  import { Connection } from "../lib/connection";
  import { loadProjectRoot } from "../lib/file-tree";
  import FileTree from "./FileTree.svelte";
  import GitPanel from "./GitPanel.svelte";

  let { conn, onOpenFile, onOpenDiff, onCd, getFocusedPwd, rootTick, onToast }: {
    conn: Connection; onOpenFile: (path: string) => void; onOpenDiff: (path: string) => void; onCd: (path: string) => void;
    getFocusedPwd: () => Promise<{ pwd: string } | { error: string }>;
    rootTick: number;
    onToast: (msg: string) => void;
  } = $props();
  let sub = $state<"dir" | "git">("dir");

  // Show the current branch beside the Git sub-tab so it's visible without
  // opening the Git panel. Non-repo / errors just hide it.
  let branch = $state("");
  async function refreshBranch() {
    try {
      const r = (await conn.rpc("git.branches", { cwd: loadProjectRoot() })) as { current: string };
      branch = r.current ?? "";
    } catch { branch = ""; }
  }
  // Runs on mount and whenever the project root follow bumps rootTick.
  $effect(() => { rootTick; void refreshBranch(); });
</script>

<div class="fp">
  <div class="subtabs">
    <button class:on={sub === "dir"} onclick={() => (sub = "dir")}>目录</button>
    <button class:on={sub === "git"} onclick={() => (sub = "git")}>Git{#if branch}<span class="branch">{branch}</span>{/if}</button>
  </div>
  <div class="body">
    {#if sub === "dir"}
      <FileTree {conn} {onOpenFile} {onCd} {getFocusedPwd} {rootTick} {onToast} onRefresh={refreshBranch} />
    {:else}
      <GitPanel {conn} {onOpenDiff} />
    {/if}
  </div>
</div>

<style>
  .fp { display: flex; flex-direction: column; height: 100%; }
  .subtabs { display: flex; gap: 6px; padding: 6px 8px; flex: 0 0 auto; }
  .subtabs button { flex: 1; padding: 6px 0; border: 1px solid var(--line); background: var(--panel); color: var(--dim); border-radius: var(--radius-md); font-size: 0.72rem; }
  .subtabs button.on { background: var(--panel2); color: var(--text); border-color: var(--line-strong); }
  .branch { margin-left: 4px; font-size: 0.6rem; color: var(--amber); font-weight: 600; }
  .body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
</style>
