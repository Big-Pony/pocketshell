<script lang="ts">
  let { items, onClose }: {
    items: { label: string; icon?: string; danger?: boolean; onSelect: () => void }[];
    onClose: () => void;
  } = $props();
</script>

<div class="ctxmenu">
  {#each items as it}
    <button class:danger={it.danger} onclick={() => { it.onSelect(); onClose(); }}>
      {#if it.icon}<span class="ic">{it.icon}</span>{/if}{it.label}
    </button>
  {/each}
  <div class="sep"></div>
  <button onclick={onClose}>取消</button>
</div>

<style>
  .ctxmenu { position: absolute; z-index: 30; left: 10px; top: 10px; background: #1e2936; border: 1px solid var(--line-strong); border-radius: var(--radius-xl); padding: 4px 0; min-width: 160px; box-shadow: 0 8px 24px rgba(0,0,0,0.45); display: flex; flex-direction: column; }
  .ctxmenu button { background: transparent; border: 0; padding: 9px 14px; font-size: 0.73rem; color: var(--text); text-align: left; display: flex; align-items: center; gap: 8px; }
  .ctxmenu button:active { background: var(--key); }
  .ctxmenu .danger { color: var(--red); }
  .ctxmenu .sep { height: 1px; background: var(--line); margin: 3px 0; }
  .ic { font-size: 0.8rem; }
</style>
