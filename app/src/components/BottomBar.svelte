<!-- app/src/components/BottomBar.svelte -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { BottomPanel } from "../lib/ui/shell";
  let { active, taskBadge = false, onSelect }: {
    active: BottomPanel; taskBadge?: boolean; onSelect: (p: BottomPanel) => void;
  } = $props();

  // 线性 SVG 图标（20×20，stroke-width:2）取代原来的字符图标（▶ 🗀 ⌨ ⚡ ⚙）：
  // 字符图标在不同安卓机上走各自的 emoji/符号字体，粗细与基线都不一致。
  // `d` 是每个图标的路径集合，渲染时统一套同一个 <svg> 外壳。
  const tabs: { id: BottomPanel; paths: string[]; labelKey: string; disabled?: boolean }[] = [
    { id: "task", labelKey: "bottombar.task", paths: ["M2 3h20v18H2z", "m5 8 4 4-4 4", "M13 16h6"] },
    { id: "file", labelKey: "bottombar.file", paths: ["M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"] },
    { id: "kbd", labelKey: "bottombar.kbd", paths: ["M2 4h20v16H2z", "M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"] },
    { id: "snip", labelKey: "bottombar.snip", paths: ["M13 2 3 14h9l-1 8 10-12h-9l1-8Z"] },
    { id: "set", labelKey: "bottombar.set", paths: ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"] },
  ];
</script>

<nav class="bar">
  {#each tabs as tab (tab.id)}
    <button
      class="btab"
      class:active={active === tab.id}
      class:disabled={tab.disabled}
      disabled={tab.disabled}
      onclick={() => !tab.disabled && onSelect(tab.id)}
      title={tab.disabled ? $t('bottombar.fileP1') : $t(tab.labelKey)}
    >
      <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {#each tab.paths as d (d)}<path {d} />{/each}
      </svg>
      <span class="lb">{$t(tab.labelKey)}</span>
      {#if tab.id === "task" && taskBadge}<span class="dot"></span>{/if}
    </button>
  {/each}
</nav>

<style>
  .bar {
    display: flex;
    background: var(--bb-bg);
    border-top: 1px solid var(--bb-line);
    flex: 0 0 auto;
    padding: 0 2px var(--safe-bottom);
    height: calc(57px + var(--safe-bottom));
  }
  .btab {
    flex: 1;
    background: transparent;
    border: 0;
    color: var(--dimmer);
    padding: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    font-size: 0.6rem;
    user-select: none;
    position: relative;
    transition: background 0.15s, color 0.15s;
  }
  .btab.active {
    color: var(--bb-active);
  }
  /* 贴边指示条：顶端与底栏上沿齐平，不再浮在上方 */
  .btab.active::before {
    content: "";
    position: absolute;
    top: 0;
    width: 24px;
    height: 2px;
    border-radius: 0 0 2px 2px;
    background: var(--bb-indicator);
  }
  .btab.disabled {
    color: var(--dimmer);
    opacity: 0.5;
  }
  .btab:not(.disabled):active {
    background: var(--accent-soft);
  }
  .ic { width: 20px; height: 20px; display: block; }
  .lb { font-size: 0.6rem; }
  .dot {
    position: absolute;
    top: 9px;
    right: 14%;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--amber);
    animation: pulse 1s infinite;
  }
  @keyframes pulse { 50% { opacity: 0.35; } }
</style>
