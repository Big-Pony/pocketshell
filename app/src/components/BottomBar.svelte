<!-- app/src/components/BottomBar.svelte -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { BottomPanel } from "../lib/shell";
  let { active, taskBadge = false, onSelect }: {
    active: BottomPanel; taskBadge?: boolean; onSelect: (p: BottomPanel) => void;
  } = $props();

  const tabs: { id: BottomPanel; icon: string; labelKey: string; disabled?: boolean }[] = [
    { id: "task", icon: "▶", labelKey: "bottombar.task" },
    { id: "file", icon: "🗀", labelKey: "bottombar.file" },
    { id: "kbd", icon: "⌨", labelKey: "bottombar.kbd" },
    { id: "snip", icon: "⚡", labelKey: "bottombar.snip" },
    { id: "set", icon: "⚙", labelKey: "bottombar.set" },
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
      <span class="ic">{tab.icon}</span>
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
    padding: 4px 2px calc(6px + var(--safe-bottom));
  }
  .btab {
    flex: 1;
    background: transparent;
    border: 0;
    color: var(--dimmer);
    padding: 6px 0 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    font-size: 0.6rem;
    border-radius: var(--radius-lg);
    user-select: none;
    position: relative;
    transition: background 0.15s, color 0.15s;
  }
  .btab.active {
    color: var(--bb-active);
    font-weight: 600;
  }
  .btab.active::before {
    content: "";
    position: absolute;
    top: -5px;
    width: 22px;
    height: 2.5px;
    border-radius: 2px;
    background: var(--bb-indicator);
  }
  .btab.disabled {
    color: var(--dimmer);
    opacity: 0.5;
  }
  .btab:not(.disabled):active {
    background: var(--accent-soft);
  }
  .ic { font-size: 1rem; line-height: 1; margin-bottom: 2px; }
  .lb { font-size: 0.6rem; }
  .dot {
    position: absolute;
    top: 4px;
    right: 14%;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--amber);
    animation: pulse 1s infinite;
  }
  @keyframes pulse { 50% { opacity: 0.35; } }
</style>
