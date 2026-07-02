<script lang="ts">
  import type { SessionMeta } from "../lib/protocol";
  import { stateDotClass } from "../lib/session-view";

  let {
    sessions,
    activeId,
    onSelect,
    onNew,
  }: {
    sessions: SessionMeta[];
    activeId: string;
    onSelect: (name: string) => void;
    onNew: (name: string) => void;
  } = $props();

  let adding = $state(false);
  let draft = $state("");

  function submit() {
    const name = draft.trim();
    if (name) onNew(name);
    draft = "";
    adding = false;
  }

  function autoFocus(node: HTMLElement) {
    node.focus();
  }
</script>

<nav class="tabs">
  {#each sessions as s (s.name)}
    <button
      class="tab"
      class:active={s.name === activeId}
      onclick={() => onSelect(s.name)}
    >
      <span class="dot {stateDotClass(s.state)}"></span>{s.name}
    </button>
  {/each}

  {#if adding}
    <input
      class="new-input"
      use:autoFocus
      bind:value={draft}
      placeholder="session name"
      onkeydown={(e) => e.key === "Enter" && submit()}
      onblur={submit}
    />
  {:else}
    <button class="tab add" onclick={() => (adding = true)} aria-label="new session">＋</button>
  {/if}
</nav>

<style>
  .tabs { display: flex; gap: 4px; overflow-x: auto; background: #111; padding: 4px; }
  .tab { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border: 0;
         background: #222; color: #ccc; font-size: 13px; white-space: nowrap; border-radius: 6px; cursor: pointer; }
  .tab.active { background: #2d4; color: #000; }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot-run { background: #2d4; }
  .dot-wait { background: #fd3; }
  .dot-done { background: #888; }
  .new-input { background: #222; color: #eee; border: 1px solid #444; border-radius: 6px; padding: 6px; }
</style>
