<script lang="ts">
  // 细进度条：无形状的等待（"动作还没完成"）。
  //
  // 与 Skeleton 的分工：点了保存、切了档位、拨了开关——这些没有"内容形状"
  // 可言，硬套骨架屏会把已有内容清空，那是倒退（GitReview 的第四种加载态
  // 已经踩过这个认识：⟳ 刷新时保留旧内容，只让按钮转）。
  //
  // 视觉刻意克制：2px 高、主色但压低不透明度，贴在容器顶部。

  let { value = null, delayMs = 300 }: {
    /** null = 不确定进度（来回游走）；0..1 = 按比例推进 */
    value?: number | null;
    delayMs?: number;
  } = $props();

  let show = $state(false);
  $effect(() => {
    const ms = delayMs;
    if (ms <= 0) { show = true; return; }
    show = false;
    const id = setTimeout(() => { show = true; }, ms);
    return () => clearTimeout(id);
  });

  const indet = $derived(value === null || value === undefined || !Number.isFinite(value));
  const pct = $derived(indet ? 0 : Math.round(Math.min(1, Math.max(0, value as number)) * 100));
</script>

{#if show}
  <div
    class="pl"
    class:indet
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={indet ? undefined : pct}
  >
    <div class="pl-fill" style:width={indet ? undefined : `${pct}%`}></div>
  </div>
{/if}

<style>
  .pl {
    position: relative; height: 2px; width: 100%; overflow: hidden;
    background: var(--line-soft);
    flex: 0 0 auto;
  }
  /* 实心那道用 --accent，但在不确定模式下只占一小段，整体不喧宾夺主；
     槽用 --line-soft（alpha 极低的分隔色），正好是"清淡"要的浓度。 */
  .pl-fill {
    height: 100%; background: var(--accent);
    transition: width var(--dur-base, 0.18s) var(--ease-out, ease-out);
  }
  /* 不确定进度：一小段来回游走。用 transform 而非 left，走合成层不触发布局。 */
  .pl.indet .pl-fill {
    width: 34%;
    transition: none;
    animation: pl-slide 1.3s var(--ease-breathe, ease-in-out) infinite;
  }
  @keyframes pl-slide {
    from { transform: translateX(-100%); }
    to { transform: translateX(295%); }
  }

  /* reduced-motion：变成一条静态细条（14 期定调）。
     不确定进度下用一条半透明满宽替代游走——存在感还在，但不动。 */
  @media (prefers-reduced-motion: reduce) {
    .pl.indet .pl-fill { animation: none; width: 100%; opacity: 0.4; }
    .pl-fill { transition: none; }
  }
</style>
