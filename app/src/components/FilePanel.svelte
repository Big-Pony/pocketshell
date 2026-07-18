<script lang="ts">
  import { t } from "svelte-i18n";
  import { Connection } from "../lib/connection";
  import { loadProjectRoot } from "../lib/file-tree";
  import FileTree from "./FileTree.svelte";
  import GitPanel from "./GitPanel.svelte";

  let { conn, onOpenFile, onOpenDiff, onCd, getFocusedPwd, rootTick, refreshTick = 0, onToast, onNewFile }: {
    conn: Connection; onOpenFile: (path: string) => void; onOpenDiff: (path: string) => void; onCd: (path: string) => void;
    getFocusedPwd: () => Promise<{ pwd: string } | { error: string }>;
    rootTick: number;
    refreshTick?: number;
    onToast: (msg: string) => void;
    onNewFile?: (dir: string, name: string) => Promise<boolean> | void;
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
    <button class:on={sub === "dir"} onclick={() => (sub = "dir")}>{$t('filepanel.dir')}</button>
    <button class:on={sub === "git"} onclick={() => (sub = "git")}>Git{#if branch}<span class="branch">{branch}</span>{/if}</button>
  </div>
  <div class="body">
    {#if sub === "dir"}
      <FileTree {conn} {onOpenFile} {onCd} {getFocusedPwd} {rootTick} {refreshTick} {onToast} onRefresh={refreshBranch} {onNewFile} />
    {:else}
      <GitPanel {conn} {onOpenDiff} />
    {/if}
  </div>
</div>

<style>
  .fp { display: flex; flex-direction: column; height: 100%; }
  .subtabs { display: flex; gap: 4px; margin: 6px 8px; padding: 3px; flex: 0 0 auto; background: var(--seg-bg); border: 1px solid var(--seg-line); border-radius: 999px; }
  .subtabs button { flex: 1; padding: 6px 0; border: 0; background: transparent; color: var(--dim); border-radius: 999px; font-size: 0.72rem; }
  .subtabs button.on { background: var(--seg-active-bg); color: var(--seg-active-text); font-weight: 600; box-shadow: var(--seg-shadow); }
  .branch { margin-left: 4px; font-size: 0.6rem; color: var(--amber); font-weight: 600; }
  .body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
</style>
