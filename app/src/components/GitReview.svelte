<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import { Connection } from "../lib/net/connection";
  import type { ReviewScope, ReviewResult, ReviewFile } from "../lib/net/protocol";
  import { shouldFold, reviewCacheKey, bodyState } from "../lib/ui/git-review";

  /** 超过这个时长仍未返回就提示"正在读取较大的改动…"。不是进度，只是告诉
      用户没卡死——rpcDeadlineMs 下大 diff 的死线可达数分钟。 */
  const SLOW_MS = 5000;

  let { conn, cwd, scope, onClose, onTotals, onPickBaseline = () => {} }: {
    conn: Connection; cwd: string; scope: ReviewScope;
    onClose: () => void;
    onTotals?: (t: { files: number; add: number; del: number }) => void;
    onPickBaseline?: () => void;
  } = $props();

  let data = $state<ReviewResult | null>(null);
  let loading = $state(true);
  let error = $state("");

  // 展开状态按 path 记账。**不放进 ReviewFile**：那是服务端数据的形状，
  // 混入 UI 态会让缓存复用时把上次的展开状态一起带回来。
  let opened = $state<Record<string, boolean>>({});

  const cache = new Map<string, ReviewResult>();

  // 当前生效的 scope（切档改这个，props.scope 只作初值）。
  let cur = $state<ReviewScope>(scope);
  let refreshing = $state(false);
  let slow = $state(false);
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  const isWorktree = $derived(cur.kind === "worktree");
  const curStage = $derived(cur.kind === "worktree" ? cur.stage : "all");

  function clearSlow() {
    slow = false;
    if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
  }

  async function load(s: ReviewScope, opts: { refresh?: boolean } = {}) {
    const key = reviewCacheKey(s);
    const hit = opts.refresh ? undefined : cache.get(key);
    if (hit) { apply(hit); return; }          // 命中缓存：不进 loading 态

    // 刷新保留旧内容（旧数据仍有参考价值），首次/切档进骨架屏。
    if (opts.refresh) refreshing = true; else loading = true;
    error = "";
    clearSlow();
    slowTimer = setTimeout(() => (slow = true), SLOW_MS);
    try {
      const r = (await conn.rpc("git.review", { cwd, scope: s })) as ReviewResult;
      cache.set(key, r);
      apply(r);
    } catch (e: any) {
      error = errText(e);
      if (!opts.refresh) data = null;   // 刷新失败时旧内容留着
    } finally {
      loading = false; refreshing = false;
      clearSlow();
    }
  }

  function apply(r: ReviewResult) {
    data = r;
    opened = Object.fromEntries(r.files.map((f) => [f.path, !shouldFold(f)]));
    onTotals?.(r.totals);
  }

  function errText(e: any): string {
    const m = String(e?.message ?? "");
    if (/not_a_repo/.test(m)) return tr("git.notRepo");
    if (/bad_revision/.test(m)) return tr("git.review.badRevision");
    if (/no_baseline/.test(m)) return tr("git.review.noBaseline");
    return m || tr("git.loadFailed");
  }

  // oversize / binary / 删除 / 新目录本就没有正文，点击不该产生"展开了但空的"状态。
  function toggle(f: ReviewFile) {
    if (bodyState(f) !== "hunks") return;
    opened = { ...opened, [f.path]: !opened[f.path] };
  }

  function pick(stage: "all" | "staged" | "unstaged") {
    cur = { kind: "worktree", stage };   // $effect 会跟着重拉
  }

  function refresh() {
    if (refreshing) return;
    cache.clear();                        // ⟳ 的语义就是"我怀疑全都旧了"
    void load(cur, { refresh: true });
  }

  function retry() { void load(cur); }

  $effect(() => { void load(cur); });
</script>

<div class="rv">
  <div class="rv-top">
    <div class="rv-title">
      <button class="rv-back" aria-label={$t('git.review.back')} onclick={onClose}>‹</button>
      <div class="rv-scope">
        <span class="tt">{data?.title || $t('git.review.titleWorktree')}</span>
        <div class="kind">{data?.subtitle || $t('git.review.subtitleWorktree')}</div>
      </div>
      <button class="rv-rf" aria-label={$t('git.refresh')} disabled={refreshing} class:spin={refreshing} onclick={refresh}>⟳</button>
    </div>
    {#if data}
      <div class="rv-sum mono">
        <span>{$t('git.review.summaryFiles', { values: { n: data.totals.files } })}</span>
        <span class="plus">+{data.totals.add}</span>
        <span class="minus">−{data.totals.del}</span>
      </div>
    {/if}
    {#if isWorktree}
      <div class="segs">
        {#each (["all", "staged", "unstaged"] as const) as s}
          <button class="seg" class:on={curStage === s} onclick={() => pick(s)}>
            {s === "all" ? $t('git.review.segAll') : s === "staged" ? $t('git.review.segStaged') : $t('git.review.segUnstaged')}
            {#if data?.counts}<span class="n mono">{data.counts[s]}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
    <!-- 基线名一律取自响应体：前端不猜基线（scope 里不带 base），
         由后端 inferBaseline 决定并回在 baseline 里。 -->
    {#if cur.kind === "range" && data?.baseline}
      <div class="baseline">
        {$t('git.review.baselineLabel')}
        <button class="bl mono" onclick={onPickBaseline}>{data.baseline.base}</button>
        {#if data.baseline.inferred}<span class="bi">（{$t('git.review.baselineInferred')}）</span>{/if}
      </div>
    {/if}
  </div>

  <div class="rv-body">
    {#if error}
      <div class="err">{error}<button class="retry" onclick={retry}>{$t('git.review.retry')}</button></div>
    {/if}
    {#if loading && !error}
      {#each [0, 1, 2, 3] as _i}
        <div class="sk-file"></div>
        {#each [0, 1] as _j}<div class="sk-line"></div>{/each}
      {/each}
      {#if slow}<div class="note center">{$t('git.review.loadingSlow')}</div>{/if}
    {:else if data && data.files.length === 0}
      <div class="empty">{$t('git.review.noChanges')}</div>
    {:else if data}
      {#each data.files as f (f.path)}
        <button class="fh" data-head={f.path} onclick={() => toggle(f)}>
          <span class="tw">{opened[f.path] ? "▾" : "▸"}</span>
          <span class="fp mono">{f.path}</span>
          {#if f.staged}
            <span class="badge" class:b-part={f.staged === "partial"}>
              {f.staged === "partial" ? $t('git.review.badgePartial') : $t('git.review.badgeStaged')}
            </span>
          {/if}
          <span class="fn mono"><span class="p">+{f.add}</span> <span class="d">−{f.del}</span></span>
        </button>

        <div class="fb" data-path={f.path}>
          {#if bodyState(f) === "oversize"}
            <div class="note center">{$t('git.review.oversize')}
              <em>{$t('git.review.oversizeHint', { values: { n: f.add + f.del } })}</em></div>
          {:else if bodyState(f) === "binary"}
            <div class="note center">{$t('git.review.binary')}</div>
          {:else if bodyState(f) === "newdir"}
            <div class="note">{$t('git.review.newdir')}<em>{$t('git.review.newdirHint')}</em></div>
          {:else if bodyState(f) === "deleted"}
            <div class="note">{$t('git.review.deleted')}</div>
          {:else if bodyState(f) === "empty"}
            <div class="note">{$t('git.review.emptyBody')}</div>
          {:else if !opened[f.path]}
            <div class="note">{$t('git.review.folded')}<em>{$t('git.review.foldedHint')}</em></div>
          {:else}
            <!-- 折叠时整个 hunk 子树不进 DOM（不是 display:none）——P3 -->
            {#each f.hunks ?? [] as hk}
              <div class="hh mono">{hk.header}</div>
              {#each hk.lines as l}
                <div class="ln {l.kind}"><span class="tx mono">{l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}{l.text}</span></div>
              {/each}
            {/each}
          {/if}
        </div>
      {/each}

      {#if data.truncated}<div class="note center trunc">{$t('git.review.truncatedNote')}</div>{/if}
      <div class="end">— {$t('git.review.end', { values: { n: data.totals.files } })} —</div>
    {/if}
  </div>
</div>

<style>
  .rv { position: fixed; inset: 0; z-index: 40; display: flex; flex-direction: column; background: var(--bg); }
  .rv-top { flex: 0 0 auto; border-bottom: 1px solid var(--line); }
  .rv-title { display: flex; align-items: center; gap: 8px; padding: 9px 10px 7px; }
  .rv-back { background: transparent; border: 0; color: var(--accent); font-size: 0.9rem; padding: 0 2px; }
  .rv-scope { flex: 1; min-width: 0; }
  .tt { font-size: 0.76rem; color: var(--text); }
  .kind { color: var(--dim); font-size: 0.66rem; }
  .rv-sum { display: flex; gap: 10px; padding: 0 10px 8px; font-size: 0.66rem; color: var(--dim); }
  .plus { color: var(--ok); } .minus { color: var(--red); }
  .mono { font-family: var(--font-mono); }

  .rv-body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: 45vh; }

  /* sticky 文件头：滑到哪都知道自己在哪个文件里 */
  .fh {
    position: sticky; top: 0; z-index: 2;
    display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
    padding: 7px 10px; font-size: 0.7rem; color: var(--text);
    background: var(--panel); border: 0;
    border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
  }
  .tw { color: var(--dimmer); width: 9px; flex: 0 0 auto; font-size: 0.6rem; }
  /* 长路径截左侧保右侧（文件名比目录更有辨识度） */
  .fp { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .fn { font-size: 0.62rem; color: var(--dim); flex: 0 0 auto; }
  .fn .p { color: var(--ok); } .fn .d { color: var(--red); }
  .badge { font-size: 0.56rem; padding: 1px 5px; border-radius: 3px; flex: 0 0 auto; background: var(--ok-soft); color: var(--ok); }
  .badge.b-part { background: var(--amber-soft); color: var(--amber); }

  .hh { font-size: 0.62rem; color: var(--dimmer); padding: 5px 10px 3px; background: var(--bg-deep); }
  .ln { display: flex; font-size: 0.66rem; line-height: 1.55; }
  .tx { flex: 1; min-width: 0; white-space: pre; overflow-x: auto; padding: 0 8px; }
  .ln.add { background: var(--ok-soft); } .ln.add .tx { color: var(--ok); }
  .ln.del { background: var(--red-soft); } .ln.del .tx { color: var(--red); }
  .ln.ctx .tx { color: var(--dim); }

  .note { padding: 9px 12px 11px; color: var(--dim); font-size: 0.68rem; }
  .note.center { text-align: center; }
  .note em { font-style: normal; color: var(--dimmer); font-size: 0.63rem; display: block; margin-top: 2px; }
  .trunc { color: var(--amber); }
  .err, .empty { padding: 16px 12px; color: var(--dim); font-size: 0.7rem; text-align: center; }
  .err { color: var(--amber); }
  .end { padding: 16px 12px 8px; text-align: center; color: var(--dimmer); font-size: 0.64rem; }

  .rv-rf {
    background: transparent; border: 1px solid var(--line); border-radius: var(--radius-md);
    color: var(--text); min-width: 28px; height: 24px; font-size: 0.72rem; line-height: 1; flex: 0 0 auto;
  }
  .rv-rf:disabled { opacity: 0.45; }
  .rv-rf.spin { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .segs { display: flex; margin: 0 10px 8px; border: 1px solid var(--line); border-radius: var(--radius-md); overflow: hidden; }
  .seg { flex: 1; background: transparent; border: 0; border-right: 1px solid var(--line); color: var(--dim); padding: 6px 0; font-size: 0.68rem; }
  .seg:last-child { border-right: 0; }
  .seg.on { background: var(--accent-soft); color: var(--accent); }
  .seg .n { font-size: 0.6rem; opacity: 0.75; }

  .baseline { display: flex; align-items: center; gap: 6px; margin: 0 10px 8px; font-size: 0.66rem; color: var(--dim); }
  .bl { background: transparent; border: 1px solid var(--line); border-radius: 4px; color: var(--accent); font-size: 0.66rem; padding: 2px 7px; }
  .bi { color: var(--dimmer); }

  /* 骨架屏：比转圈更能传达"这里将是一列文件"，也避免高度塌陷导致的跳动 */
  .sk-file { height: 30px; margin-bottom: 2px; background: var(--panel); opacity: 0.6; animation: breathe 1.4s ease-in-out infinite alternate; }
  .sk-line { height: 14px; margin: 3px 10px; background: var(--line); border-radius: 3px; animation: breathe 1.4s ease-in-out infinite alternate; }
  @keyframes breathe { from { opacity: 0.35; } to { opacity: 0.75; } }

  /* 前庭障碍用户把动画全关掉，只留静态灰块 */
  @media (prefers-reduced-motion: reduce) {
    .sk-file, .sk-line, .rv-rf.spin { animation: none; }
  }

  .retry { display: block; margin: 10px auto 0; background: transparent; border: 1px solid var(--line); border-radius: var(--radius-md); color: var(--accent); font-size: 0.68rem; padding: 5px 14px; }
</style>
