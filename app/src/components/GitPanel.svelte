<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import { Connection } from "../lib/connection";
  import { loadProjectRoot } from "../lib/file-tree";

  let { conn, onOpenDiff }: { conn: Connection; onOpenDiff: (path: string) => void } = $props();

  const root = loadProjectRoot();
  const noRoot = root === "/";
  let branches = $state<{ current: string; branches: string[] }>({ current: "", branches: [] });
  let commits = $state<any[]>([]);
  let changes = $state<{ path: string; status: string }[]>([]);
  let limit = $state(30);
  let notice = $state("");
  let expanded = $state<string | null>(null);

  async function loadAll() {
    if (noRoot) return;
    notice = "";
    try {
      branches = (await conn.rpc("git.branches", { cwd: root })) as any;
      commits = ((await conn.rpc("git.log", { cwd: root, limit })) as any).commits;
      changes = ((await conn.rpc("git.status", { cwd: root })) as any).files;
    } catch (e: any) {
      notice = e?.code === "rpc_error" && /not_a_repo/.test(e?.message) ? tr("git.notRepo") : (e?.message ?? tr("git.loadFailed"));
    }
  }
  async function loadMore() { limit += 30; await loadAll(); }

  // Load once on mount. Guarding on `!commits.length && !notice` would re-fire
  // forever on a repo with zero commits / a clean tree (loadAll succeeds but
  // leaves commits=[] and notice=""), producing an unbounded git.* rpc storm.
  // loadMore() re-runs loadAll() explicitly, so the effect only covers mount.
  let didLoad = false;
  $effect(() => { if (!noRoot && !didLoad) { didLoad = true; void loadAll(); } });
</script>

<div class="git">
  {#if noRoot}
    <div class="hint">{$t('git.needRoot')}</div>
  {:else}
    {#if notice}<div class="gn">{notice}</div>{/if}
    <div class="sec">
      <div class="st">{$t('git.branches')}</div>
      <div class="cur mono">● {branches.current}</div>
      <div class="brs">{#each branches.branches as b}<span class="br mono" class:on={b === branches.current}>{b}</span>{/each}</div>
      <div class="tip">{$t('git.branchTip')}</div>
    </div>
    <div class="sec">
      <div class="st">{$t('git.changes')}</div>
      {#each changes as c}
        <button class="chg" onclick={() => onOpenDiff((root === "/" ? "" : root) + "/" + c.path)}>
          <span class="g g-{c.status}">{c.status}</span><span class="cp mono">{c.path}</span>
        </button>
      {/each}
      {#if !changes.length}<div class="empty">{$t('git.clean')}</div>{/if}
    </div>
    <div class="sec">
      <div class="st">{$t('git.history')}</div>
      {#each commits as c}
        <button class="cm" onclick={() => (expanded = expanded === c.hash ? null : c.hash)}>
          <span class="h mono">{c.hash.slice(0, 7)}</span><span class="m">{c.msg}</span>
          <span class="meta">{c.author} · {c.when}</span>
        </button>
        {#if expanded === c.hash}
          <div class="files">{#each c.files as f}<div class="cf mono">{f.path} <em>+{f.add} -{f.del}</em></div>{/each}</div>
        {/if}
      {/each}
      <button class="more" onclick={loadMore}>{$t('git.loadMore')}</button>
    </div>
  {/if}
</div>

<style>
  .git { height: 100%; overflow-y: auto; padding: 8px; font-size: 0.72rem; }
  .hint, .empty, .gn { color: var(--dim); padding: 10px; }
  .gn { color: var(--amber); }
  .sec { margin-bottom: 12px; }
  .st { color: var(--accent-text); font-weight: 600; margin-bottom: 4px; }
  .cur { color: var(--text); }
  .brs { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
  .br { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 2px 6px; color: var(--dim); }
  .br.on { color: var(--accent-text); border-color: var(--accent); }
  .tip { color: var(--dimmer); font-size: 0.64rem; }
  .chg, .cm, .more { display: flex; gap: 6px; width: 100%; text-align: left; border: 0; background: transparent; color: var(--text); padding: 6px 4px; align-items: center; }
  .chg:active, .cm:active { background: var(--panel); }
  .g { font-weight: 700; } .g-M { color: var(--amber); } .g-A { color: var(--ok); } .g-D { color: var(--red); } .g-\? { color: var(--dim); }
  .cm { flex-wrap: wrap; } .h { color: var(--amber); } .m { flex: 1; } .meta { color: var(--dim); font-size: 0.64rem; width: 100%; }
  .files { padding: 2px 0 6px 14px; } .cf em { color: var(--dim); font-style: normal; }
  .more { color: var(--accent-text); justify-content: center; }
</style>
