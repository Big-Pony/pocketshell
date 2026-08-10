<script lang="ts">
  // 骨架屏：有形状的等待（"内容还没来"）。
  //
  // 参数与视觉照搬 GitReview 已验证的那套（--panel 做块、--line 做细条、
  // 1.4s 呼吸、透明度 0.35↔0.75）——那是本项目唯一被真机与测试都验过的
  // 加载视觉，没有理由另起一套。
  //
  // 为什么不是转圈：转圈只说"在等"，骨架屏还说了"这里将是一列文件"，
  // 并且占住高度、避免内容到达时的跳动。

  let { rows = 3, variant = "list", delayMs = 300 }: {
    rows?: number;
    /** list=等宽条 / tree=带缩进 / text=更细更密（模拟代码行） */
    variant?: "list" | "tree" | "text";
    /** 短于此毫秒数的等待不显示任何东西。局域网下大量 RPC 50ms 就回来，
     *  无差别显示会变成闪烁，比没有更烦。传 0 用于已知必然慢的场景。 */
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
</script>

{#if show}
  <div class="sk" data-variant={variant} aria-busy="true" aria-live="polite">
    {#each Array(rows) as _, i (i)}
      <div class="sk-row" style:--i={i}>
        <div class="sk-block"></div>
        <div class="sk-line"></div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .sk { padding: 6px 0; }
  .sk-row { margin-bottom: 6px; }
  /* 块与细条的两级层次照抄 GitReview：块用 --panel（面板色，视觉上"是一块内容"），
     细条用 --line（分隔线色，更轻）。两者都在 layer() 阶梯上，纯黑/纯白主题下
     也有保底可见度（theme-derive.ts 的绝对下限保证）。 */
  .sk-block {
    height: 22px; background: var(--panel); border-radius: var(--radius-sm);
    animation: sk-breathe 1.4s var(--ease-breathe, ease-in-out) infinite alternate;
    /* 每行错开一点相位，避免整块同时明灭像在闪 */
    animation-delay: calc(var(--i, 0) * 0.12s);
  }
  .sk-line {
    height: 10px; margin: 5px 10px 0 0; background: var(--line); border-radius: 3px;
    animation: sk-breathe 1.4s var(--ease-breathe, ease-in-out) infinite alternate;
    animation-delay: calc(var(--i, 0) * 0.12s + 0.06s);
  }

  /* tree：带缩进，模拟目录层级 */
  .sk[data-variant="tree"] .sk-row { padding-left: calc(var(--i, 0) * 10px); }
  .sk[data-variant="tree"] .sk-block { height: 18px; }
  .sk[data-variant="tree"] .sk-line { display: none; }

  /* text：更细更密，模拟代码行；宽度递减避免整齐得像表格 */
  .sk[data-variant="text"] .sk-row { margin-bottom: 3px; }
  .sk[data-variant="text"] .sk-block { height: 11px; width: calc(92% - var(--i, 0) * 7%); }
  .sk[data-variant="text"] .sk-line { display: none; }

  @keyframes sk-breathe { from { opacity: 0.35; } to { opacity: 0.75; } }

  /* 前庭障碍用户把动画全关掉，只留静态灰块——形状信息不依赖动画。
     14 期定调：加载反馈也停动画（app.css 的注释已同步改写）。 */
  @media (prefers-reduced-motion: reduce) {
    .sk-block, .sk-line { animation: none; opacity: 0.55; }
  }
</style>
