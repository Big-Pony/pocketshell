<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import { Connection } from "../lib/net/connection";
  import { loadProjectRoot } from "../lib/ui/file-tree";
  import { orderBranches, visibleBranches, BRANCH_LIMIT } from "../lib/ui/branch-list";
  import GitReview from "./GitReview.svelte";
  import Skeleton from "./ui/Skeleton.svelte";
  import type { ReviewScope } from "../lib/net/protocol";

  let { conn, onOpenDiff, rootTick = 0 }: {
    conn: Connection;
    onOpenDiff: (path: string) => void;
    // App 切换聚焦 tab 时 ++（项目根书签已随之改写）。默认 0 让既有测试与
    // 任何未透传该 prop 的调用方保持挂载时加载一次的原行为。
    rootTick?: number;
  } = $props();

  // 根必须是 $state 且在用时重读 localStorage——localStorage 不是响应源，
  // 冻结成 const 会让「切了 tab 后连 ⟳ 刷新都刷旧目录」（14 期需求 2 根因 A）。
  // 与 FilePanel.svelte:24 / FileTree.svelte:88 同一模式。
  let root = $state(loadProjectRoot());
  const noRoot = $derived(root === "/");
  let branches = $state<{ current: string; branches: string[] }>({ current: "", branches: [] });
  let commits = $state<any[]>([]);
  let changes = $state<{ path: string; status: string }[]>([]);
  let limit = $state(30);
  let notice = $state("");
  let refreshing = $state(false);
  // 首次挂载路径此前没有任何反馈——同一个 loadAll()，⟳ 刷新有 refreshing
  // 让按钮禁用，挂载却是一片空面板（14 期需求 5）。
  let firstLoad = $state(true);

  // 全屏审查页。null = 未打开。GitReview 自带 position:fixed，
  // 所以在这里内联渲染即可盖满视口，不用改 App.svelte 的挂载结构。
  let reviewScope = $state<ReviewScope | null>(null);

  // 入口条上的 +X −Y：现有 RPC 拿不到，**不为它新增请求**。
  // 用户进过一次审查页后用手上的 totals 回填——为一个装饰性数字
  // 多打一次 git 不划算，而"进过一次就有了"没有欺骗性。
  let wtTotals = $state<{ files: number; add: number; del: number } | null>(null);
  let rangeTotals = $state<{ files: number; add: number; del: number } | null>(null);

  // 基线名：分支列表里按 main > master > develop 优先取，都没有就退到列表
  // 第一个非当前分支。**只用于入口条的显示文案**——真正的基线由后端
  // inferBaseline 推断（scope 里不传 base），审查页里显示的是响应回来的
  // baseline.base。前端猜错也只是入口条上的一个词，不会导致拉错 diff。
  const baseGuess = $derived(
    ["main", "master", "develop"].find((b) => branches.branches.includes(b))
      ?? branches.branches.find((b) => b !== branches.current)
      ?? "main",
  );

  function openReview(s: ReviewScope) { reviewScope = s; }
  function closeReview() { reviewScope = null; }
  function onReviewTotals(t: { files: number; add: number; del: number }) {
    if (reviewScope?.kind === "range") rangeTotals = t; else wtTotals = t;
  }

  // 折叠态**不持久化**：折叠是视觉降噪而非用户偏好，且 refresh() 后分支集合
  // 可能已变，记住「展开过」没有意义。
  let brExpanded = $state(false);
  const brOrdered = $derived(orderBranches(branches.current, branches.branches));
  const brShown = $derived(visibleBranches(brOrdered, brExpanded));
  const brHidden = $derived(brOrdered.length - BRANCH_LIMIT);

  async function loadAll() {
    // 每次拉取前重读书签：⟳ 刷新与跟随切根共用这条路径，读旧值就等于刷错目录。
    root = loadProjectRoot();
    if (root === "/") return;
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
    } finally {
      firstLoad = false;
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

  // 挂载时加载一次，此后每当 rootTick 变化（App 切了聚焦 tab、项目根书签
  // 已改写）重新加载。lastTick 是**普通变量不是 $state**：effect 只应跟踪
  // rootTick，把「上次见过的值」记成响应式会让它自己触发自己。
  //
  // 不能守在 `!commits.length && !notice` 上——空仓库/干净工作树时 loadAll
  // 成功但两者都为空，会无限重放 git.* rpc。以 tick 为唯一判据即可。
  let lastTick = -1;
  $effect(() => {
    const tick = rootTick;
    if (tick === lastTick) return;
    lastTick = tick;
    void loadAll();
  });
</script>

<div class="git">
  {#if noRoot}
    <div class="hint">{$t('git.needRoot')}</div>
  {:else}
    {#if notice}<div class="gn">{notice}</div>{/if}
    {#if firstLoad}
      <!-- 14 期需求 5：首次挂载的三条并发 git RPC 期间此前是一片空面板。 -->
      <Skeleton rows={4} />
    {:else}
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
      <!-- range 一档不传 base：由后端 inferBaseline 推断，baseGuess 只是文案。 -->
      <button class="rv-entry rv-entry2" onclick={() => openReview({ kind: "range" })}>
        <span class="ic">⇄</span> {$t('git.review.entryRange', { values: { base: baseGuess } })}
        {#if rangeTotals}<span class="sub mono">{$t('git.review.entryFiles', { values: { n: rangeTotals.files } })}</span>{/if}
      </button>
    </div>
    <div class="sec">
      <div class="st">{$t('git.changes')}</div>
      {#if changes.length}
        <button class="rv-entry" onclick={() => openReview({ kind: "worktree", stage: "all" })}>
          <span class="ic">◈</span> {$t('git.review.entryAll')}
          <span class="sub mono">
            {$t('git.review.entryFiles', { values: { n: changes.length } })}
            {#if wtTotals}<span class="p">+{wtTotals.add}</span> <span class="d">−{wtTotals.del}</span>{/if}
          </span>
        </button>
      {/if}
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
        <button class="cm" onclick={() => openReview({ kind: "commit", hash: c.hash })}>
          <span class="h mono">{c.hash.slice(0, 7)}</span><span class="m">{c.msg}</span>
          <span class="arrow">›</span>
          <span class="meta">{c.author} · {c.when}</span>
        </button>
      {/each}
      <button class="more" onclick={loadMore}>{$t('git.loadMore')}</button>
    </div>
    {/if}
  {/if}
</div>

{#if reviewScope}
  <GitReview {conn} cwd={root} scope={reviewScope} onClose={closeReview} onTotals={onReviewTotals} />
{/if}

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
  .more { color: var(--accent); justify-content: center; }

  /* 审查入口条：worktree 那条用主色底强调（这是最常用的入口），
     range 那条走普通边框，避免两条都在喊 */
  .rv-entry {
    display: flex; width: 100%; align-items: center; gap: 8px; padding: 9px 10px;
    background: var(--accent-soft); border: 1px solid var(--accent);
    border-radius: var(--radius-md); color: var(--text); font-size: 0.74rem; margin: 8px 0 4px;
  }
  .rv-entry2 { background: transparent; border-color: var(--line); }
  .rv-entry .ic { color: var(--accent); }
  .rv-entry .sub { margin-left: auto; color: var(--dim); font-size: 0.66rem; }
  .rv-entry .sub .p { color: var(--ok); }
  .rv-entry .sub .d { color: var(--red); }
  .mono { font-family: var(--font-mono); }
  .cm .arrow { color: var(--dimmer); }
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
