<!-- app/src/components/StatusBar.svelte
     信息分割条：上下分区之间那条 22px 的横条。它同时是
     1) 手势目标 —— 拖拽调分区高度、双击进/出全屏（原 App.svelte 的 .divider）
     2) 信息条 —— 左 git 分支，右连接延迟与下行吞吐

     手势逻辑是从 App.svelte 原样搬过来的（onDown/onMove/onUp + clampSplit），
     行为不变；App 只负责把 splitRatio / fullscreen 的写回口子传进来。

     「数据缺失即整块隐藏」：非 git 仓库没有分支、断线没有延迟与吞吐，
     一律不显示，不留 `--` 占位符。 -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { formatLatency, formatRate, formatBranch } from "../lib/status-bar";
  import { loadTipSeen, saveTipSeen } from "../lib/status-bar-tip";

  let {
    branch = "",
    dirty = false,
    latency = null,
    rxBytes = 0,
    elapsedMs = 0,
    online = true,
    onDown,
    onMove,
    onUp,
  }: {
    branch?: string;
    dirty?: boolean;
    latency?: number | null;
    rxBytes?: number;
    elapsedMs?: number;
    online?: boolean;
    onDown: (e: PointerEvent) => void;
    onMove: (e: PointerEvent) => void;
    onUp: (e: PointerEvent) => void;
  } = $props();

  const branchText = $derived(formatBranch(branch, dirty));
  // 断线时延迟与吞吐都不显示（不是显示 0）——连接指标在没有连接时没有意义。
  const latencyText = $derived(online ? formatLatency(latency) : "");
  const rateText = $derived(online ? formatRate(rxBytes, elapsedMs) : "");

  // 首次使用给一次「双击全屏」微提示，用过或点掉即不再出现。
  let tipOpen = $state(!loadTipSeen());
  function dismissTip() {
    tipOpen = false;
    saveTipSeen();
  }
  // 用过手势（拖拽或双击）也算学会了，同样不再提示。
  function onBarDown(e: PointerEvent) {
    if (tipOpen) dismissTip();
    onDown(e);
  }
</script>

<div
  class="bar"
  role="separator"
  aria-label={$t('statusbar.aria.divider')}
  onpointerdown={onBarDown}
  onpointermove={onMove}
  onpointerup={onUp}
>
  {#if tipOpen}
    <div class="tip">
      <span>{$t('statusbar.tip.fullscreen')}</span>
      <button class="tip-x" aria-label={$t('common.close')}
        onpointerdown={(e) => { e.stopPropagation(); dismissTip(); }}>×</button>
    </div>
  {/if}

  <div class="grp">
    {#if branchText}
      <span class="s branch mono"><i></i>{branchText}</span>
    {/if}
  </div>

  <div class="grip"></div>

  <div class="grp r">
    {#if latencyText}<span class="s mono">{latencyText}</span>{/if}
    {#if rateText}<span class="s mono">↓{rateText}</span>{/if}
  </div>
</div>

<style>
  .bar {
    flex: 0 0 auto;
    height: 22px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 13px;
    position: relative;
    background: var(--bar-bg);
    border-top: 1px solid var(--line);
    color: var(--bar-text);
    font-size: 9.5px;
    letter-spacing: 0.05em;
    /* 手势目标：禁用原生滚动手势，否则拖拽会被解析成页面滚动 */
    touch-action: none;
    user-select: none;
  }
  /* 左右两组各自可压缩，抓手不可压缩（它是手势目标，宽度必须恒定） */
  .grp {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .grp.r { justify-content: flex-end; }
  .grip {
    flex: 0 0 auto;
    width: 34px;
    height: 3.5px;
    border-radius: 3px;
    background: var(--bar-grip);
  }
  .s {
    display: flex;
    align-items: center;
    gap: 5px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .branch i {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    flex: 0 0 auto;
  }

  .tip {
    position: absolute;
    left: 50%;
    translate: -50% 0;
    bottom: 24px;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
    background: var(--dlg-bg);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    padding: 5px 9px;
    font-size: 9.5px;
    color: var(--text);
    box-shadow: var(--pop-shadow);
  }
  .tip::after {
    content: "";
    position: absolute;
    left: 50%;
    bottom: -4px;
    translate: -50% 0;
    width: 7px;
    height: 7px;
    rotate: 45deg;
    background: var(--dlg-bg);
    border-right: 1px solid var(--line-strong);
    border-bottom: 1px solid var(--line-strong);
  }
  .tip-x {
    background: transparent;
    border: 0;
    color: var(--dimmer);
    font-size: 12px;
    line-height: 1;
    padding: 0 2px;
  }
</style>
