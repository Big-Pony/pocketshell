<!-- app/src/components/BottomBar.svelte -->
<script lang="ts">
  import type { BottomPanel } from "../lib/shell";
  let { active, taskBadge = false, onSelect }: {
    active: BottomPanel; taskBadge?: boolean; onSelect: (p: BottomPanel) => void;
  } = $props();

  const tabs: { id: BottomPanel; icon: string; label: string; disabled?: boolean }[] = [
    { id: "file", icon: "🗀", label: "文件", disabled: true },
    { id: "task", icon: "▶", label: "任务" },
    { id: "kbd", icon: "⌨", label: "键盘" },
    { id: "snip", icon: "⚡", label: "指令" },
    { id: "set", icon: "⚙", label: "设置" },
  ];
</script>

<nav class="bar">
  {#each tabs as t (t.id)}
    <button
      class:active={active === t.id}
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
  .bar { display: flex; background: #111; border-top: 1px solid #222; flex: 0 0 auto;
         padding-bottom: env(safe-area-inset-bottom); }
  .bar button { flex: 1; background: none; border: 0; color: #999; padding: 6px 0;
                display: flex; flex-direction: column; align-items: center; gap: 2px;
                font-size: 11px; position: relative; }
  .bar button.active { color: #2d4; }
  .bar button:disabled { color: #444; }
  .ic { font-size: 18px; line-height: 1; }
  .dot { position: absolute; top: 4px; right: 30%; width: 6px; height: 6px;
         border-radius: 50%; background: #fd3; }
</style>
