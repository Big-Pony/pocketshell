<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import { Connection } from "../lib/net/connection";
  import { loadProjectRoot } from "../lib/ui/file-tree";
  import { orderBranches, visibleBranches, BRANCH_LIMIT } from "../lib/ui/branch-list";

  let { conn, onOpenDiff }: { conn: Connection; onOpenDiff: (path: string) => void } = $props();

  const root = loadProjectRoot();
  const noRoot = root === "/";
  let branches = $state<{ current: string; branches: string[] }>({ current: "", branches: [] });
  let commits = $state<any[]>([]);
  let changes = $state<{ path: string; status: string }[]>([]);
  let limit = $state(30);
  let notice = $state("");
  let expanded = $state<string | null>(null);
  let refreshing = $state(false);

  // 折叠态**不持久化**：折叠是视觉降噪而非用户偏好，且 refresh() 后分支集合
  // 可能已变，记住「展开过」没有意义。
  let brExpanded = $state(false);
  const brOrdered = $derived(orderBranches(branches.current, branches.branches));
  const brShown = $derived(visibleBranches(brOrdered, brExpanded));
  const brHidden = $derived(brOrdered.length - BRANCH_LIMIT);

  async function loadAll() {
    if (noRoot) return;
    notice = "";
    try {
      // A8: the three reads are independent — run them concurrently instead of
      // serially (saves 2 RTTs; agent side spawns git for each).
      const [b, l, s] = await Promise.all([
        conn.rpc("git.branches", { cwd: root }),
        conn.rpc("git.log", { cwd: root, limit }),
        conn.rpc("git.status", { cwd: root }),
      ]);
      branches = b as any;
      commits = (l as any).commits;
      changes = (s as any).files;
    } catch (e: any) {
      notice = e?.code === "rpc_error" && /not_a_repo/.test(e?.message) ? tr("git.notRepo") : (e?.message ?? tr("git.loadFailed"));
    }
  }
  async function loadMore() { limit += 30; await loadAll(); }

  // 刷新整个面板（分支 + 历史 + 变更三项）。按钮位于分支行，但用户对
  // 「刷新」的预期是整块更新，不只是分支名。
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try { await loadAll(); } finally { refreshing = false; }
  }

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
      <div class="st-row">
        <span class="st">{$t('git.branches')}</span>
        <button class="rf" aria-label={$t('git.refresh')} disabled={refreshing} onclick={refresh}>⟳</button>
      </div>
      <div class="cur mono">● {branches.current}</div>
      <!-- 展开按钮长得和分支 chip 一样（同一排、同边框圆角），只是文字用亮色
           区分「这是个操作而不是一个分支」。放进 .brs 里跟着 chip 自然换行。 -->
      <div class="brs">
        {#each brShown as b}<span class="br mono" class:on={b === branches.current}>{b}</span>{/each}
        {#if brHidden > 0}
          <button class="br br-more mono" onclick={() => (brExpanded = !brExpanded)}>
            {brExpanded ? $t('git.branchCollapse') : $t('git.branchExpand', { values: { n: brHidden } })}
          </button>
        {/if}
      </div>
      <div class="tip">{$t('git.branchTip')}</div>
    </div>
    <div class="sec">
      <div class="st">{$t('git.changes')}</div>
      {#each changes as c}
        <button class="chg" onclick={() => onOpenDiff((root === "/" ? "" : root) + "/" + c.path)}>
          <span class="g g-{c.status}" title={c.status} aria-label={c.status} role="img"></span><span class="cp mono">{c.path}</span>
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
  .git { height: 100%; overflow-y: auto; padding: 8px 10px; font-size: 0.72rem; }
  .hint, .empty, .gn { color: var(--dim); padding: 10px; }
  .gn { color: var(--amber); }
  .sec { margin-bottom: 12px; }
  .st-row { display: flex; align-items: center; justify-content: space-between; }
  .rf {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    color: var(--text);
    min-width: 28px;
    height: 24px;
    font-size: 0.72rem;
    line-height: 1;
  }
  .rf:disabled { opacity: 0.45; }
  /* 分区标题走共同设计语言：mono 大写小标题 */
  .st {
    font-family: var(--font-mono);
    font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--dimmer); font-weight: 600; margin: 12px 0 6px;
  }
  .cur { color: var(--text); }
  .brs { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 5px; }
  .br { border: 1px solid var(--line); border-radius: 4px; padding: 2px 7px; color: var(--dim); }
  .br.on { color: var(--accent); border-color: var(--accent); }
  .tip { color: var(--dimmer); font-size: 0.62rem; }
  .chg, .cm, .more { display: flex; gap: 8px; width: 100%; text-align: left; border: 0; background: transparent; color: var(--text); padding: 6px 2px; align-items: center; }
  .chg:active, .cm:active { background: var(--panel); }
  /* 与目录树同一套语言：3px 竖色条，状态字母进 aria-label */
  .g { width: 3px; height: 14px; border-radius: 2px; flex: 0 0 auto; background: transparent; }
  .g-M { background: var(--amber); } .g-A { background: var(--ok); } .g-D { background: var(--red); } .g-\? { background: var(--dimmer); }
  .cm { flex-wrap: wrap; border-bottom: 1px solid var(--line); }
  .h { color: var(--accent); } .m { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--dimmer); font-size: 0.62rem; width: 100%; }
  .files { padding: 2px 0 6px 14px; } .cf em { color: var(--dim); font-style: normal; }
  .more { color: var(--accent); justify-content: center; }
  /* 展开/收起：与分支 chip 同款（.br 已给出边框、圆角、内边距），只把文字
     换成亮色以区分「操作」与「分支名」。button 的 UA 默认样式要显式抹平，
     否则和同排的 span 对不齐。 */
  .br-more {
    background: transparent;
    color: var(--accent);
    font-size: inherit;
    line-height: inherit;
    cursor: pointer;
  }
</style>
