<script lang="ts">
  let { items, onClose, anchor }: {
    items: { label: string; icon?: string; danger?: boolean; onSelect: () => void }[];
    onClose: () => void;
    anchor?: HTMLElement;
  } = $props();

  let menuEl = $state<HTMLElement | null>(null);
  let pos = $state<{ left: number; top: number }>({ left: 0, top: 0 });

  $effect(() => {
    if (!anchor || !menuEl) return;
    const rect = anchor.getBoundingClientRect();
    const mw = menuEl.offsetWidth;
    const mh = menuEl.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + mw > vw - 8) left = vw - mw - 8;
    if (left < 8) left = 8;
    if (top + mh > vh - 8) top = rect.top - mh - 4;
    if (top < 8) top = 8;
    pos = { left, top };
  });
</script>

<div class="backdrop" onclick={onClose} role="button" tabindex="-1" aria-label="关闭菜单">
  <div class="ctxmenu" bind:this={menuEl} onclick={(e) => e.stopPropagation()} style:left="{pos.left}px" style:top="{pos.top}px">
    {#each items as it}
      <button class:danger={it.danger} onclick={() => { it.onSelect(); onClose(); }}>
        {#if it.icon}<span class="ic">{it.icon}</span>{/if}{it.label}
      </button>
    {/each}
    <div class="sep"></div>
    <button onclick={onClose}>取消</button>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: transparent;
  }
  .ctxmenu {
    position: fixed;
    z-index: 31;
    background: #1e2936;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-xl);
    padding: 4px 0;
    min-width: 160px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
    display: flex;
    flex-direction: column;
  }
  .ctxmenu button {
    background: transparent;
    border: 0;
    padding: 9px 14px;
    font-size: 0.73rem;
    color: var(--text);
    text-align: left;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ctxmenu button:active { background: var(--key); }
  .ctxmenu .danger { color: var(--red); }
  .ctxmenu .sep { height: 1px; background: var(--line); margin: 3px 0; }
  .ic { font-size: 0.8rem; }
</style>
