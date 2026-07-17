<!-- app/src/components/BottomBar.svelte -->
<script lang="ts">
  import type { BottomPanel } from "../lib/shell";
  let { active, taskBadge = false, onSelect }: {
    active: BottomPanel; taskBadge?: boolean; onSelect: (p: BottomPanel) => void;
  } = $props();

  const tabs: { id: BottomPanel; icon: string; label: string; disabled?: boolean }[] = [
    { id: "task", icon: "▶", label: "任务" },
    { id: "file", icon: "🗀", label: "文件" },
    { id: "kbd", icon: "⌨", label: "键盘" },
    { id: "snip", icon: "⚡", label: "指令" },
    { id: "set", icon: "⚙", label: "设置" },
  ];
</script>

<nav class="bar">
  {#each tabs as t (t.id)}
    <button
      class="btab"
      class:active={active === t.id}
      class:disabled={t.disabled}
      disabled={t.disabled}
      onclick={() => !t.disabled && onSelect(t.id)}
      title={t.disabled ? "文件面板（P1）" : t.label}
    >
      <span class="ic">{t.icon}</span>
      <span class="lb">{t.label}</span>
      {#if t.id === "task" && taskBadge}<span class="dot"></span>{/if}
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
