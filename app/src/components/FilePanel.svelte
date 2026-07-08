<script lang="ts">
  import { Connection } from "../lib/connection";
  import FileTree from "./FileTree.svelte";
  import GitPanel from "./GitPanel.svelte";

  let { conn, onOpenFile, onOpenDiff, onCd, getFocusedPwd, rootTick, onToast }: {
    conn: Connection; onOpenFile: (path: string) => void; onOpenDiff: (path: string) => void; onCd: (path: string) => void;
    getFocusedPwd: () => Promise<{ pwd: string } | { error: string }>;
    rootTick: number;
    onToast: (msg: string) => void;
  } = $props();
  let sub = $state<"dir" | "git">("dir");
</script>

<div class="fp">
  <div class="subtabs">
    <button class:on={sub === "dir"} onclick={() => (sub = "dir")}>目录</button>
    <button class:on={sub === "git"} onclick={() => (sub = "git")}>Git</button>
  </div>
  <div class="body">
    {#if sub === "dir"}
      <FileTree {conn} {onOpenFile} {onCd} {getFocusedPwd} {rootTick} {onToast} />
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
  .body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
</style>
