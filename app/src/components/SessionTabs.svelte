<script lang="ts">
  import { stateDotClass } from "../lib/session-view";

  let {
    sessions,
    activeId,
    onSelect,
    onNew,
    onClose,
  }: {
    sessions: import("../lib/session-view").LocalSession[];
    activeId: string;
    onSelect: (name: string) => void;
    onNew: (name: string) => void;
    onClose: (name: string) => void;
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
      class:closed={s.closed}
      onclick={() => onSelect(s.name)}
    >
      <span class="dot {stateDotClass(s.state)}"></span>
      <span class="name">{s.name}</span>
      {#if s.closed}
        <span
          class="close"
          role="button"
          tabindex="0"
          onclick={(e) => { e.stopPropagation(); onClose(s.name); }}
          onkeydown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onClose(s.name); } }}
        >×</span>
      {/if}
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
  .tabs {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
    scroll-snap-type: x mandatory;
    background: var(--bg);
    padding: 0 10px 8px;
  }
  .tabs::-webkit-scrollbar { display: none; }

  .tab {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border: 1px solid var(--line);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    background: var(--panel);
    color: var(--dim);
    font-size: 0.74rem;
    white-space: nowrap;
    cursor: pointer;
    scroll-snap-align: start;
    transition: background 0.15s, color 0.15s;
  }
  .tab.active {
    background: var(--panel2);
    color: var(--text);
    border-color: var(--line-strong);
  }
  .tab.closed {
    opacity: 0.7;
  }
  .tab.add {
    padding: 5px 10px;
    font-size: 0.9rem;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .dot-run { background: var(--teal); animation: pulse 1.4s infinite; }
  .dot-wait { background: var(--amber); animation: pulse 1s infinite; }
  .dot-done { background: var(--dimmer); }
  @keyframes pulse { 50% { opacity: 0.35; } }

  .name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
  .close {
    margin-left: 2px;
    color: var(--dim);
    padding: 0 2px;
    font-size: 0.8rem;
  }
  .close:hover, .close:focus { color: var(--red); }

  .new-input {
    flex: none;
    width: 120px;
    background: var(--panel2);
    color: var(--text);
    border: 1px solid var(--line-strong);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    padding: 5px 8px;
    font-size: 0.74rem;
    outline: none;
  }
  .new-input::placeholder { color: var(--dimmer); }
</style>
