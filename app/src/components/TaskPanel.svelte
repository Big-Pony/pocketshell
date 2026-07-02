<script lang="ts">
  import type { SessionMeta } from "../lib/protocol";
  import { stateDotClass, needsKillConfirm } from "../lib/session-view";

  let {
    sessions,
    onSelect,
    onRename,
    onKill,
    onCopy,
  }: {
    sessions: SessionMeta[];
    onSelect: (name: string) => void;
    onRename: (name: string, newName: string) => void;
    onKill: (name: string) => void;
    onCopy: (name: string) => void;
  } = $props();

  let menuFor = $state<string | null>(null);   // session name whose menu is open
  let confirmKill = $state<string | null>(null); // session name pending kill confirm
  let timer: ReturnType<typeof setTimeout> | undefined;
  let longPressed = false; // set when the 500ms timer fires; consumed in click handler

  function startPress(name: string) {
    timer = setTimeout(() => { longPressed = true; menuFor = name; }, 500);
  }
  function endPress() {
    if (timer) { clearTimeout(timer); timer = undefined; }
  }
  function closeMenu() {
    menuFor = null;
  }
  function doRename(name: string) {
    const next = prompt("Rename session", name);
    closeMenu();
    if (next && next.trim() && next.trim() !== name) onRename(name, next.trim());
  }
  function requestKill(s: SessionMeta) {
    closeMenu();
    if (needsKillConfirm(s.state)) confirmKill = s.name;
    else onKill(s.name);
  }
</script>

<ul class="list">
  {#each sessions as s (s.name)}
    <li>
      <button
        class="row"
        onclick={() => { if (longPressed) { longPressed = false; return; } onSelect(s.name); }}
        onpointerdown={() => startPress(s.name)}
        onpointerup={endPress}
        onpointerleave={endPress}
      >
        <span class="dot {stateDotClass(s.state)}"></span>
        <span class="name">{s.name}</span>
        <span class="last">{s.lastLine}</span>
      </button>

      {#if menuFor === s.name}
        <div class="menu">
          <button onclick={() => doRename(s.name)}>Rename</button>
          <button onclick={() => { onCopy(s.name); closeMenu(); }}>Copy output</button>
          <button class="danger" onclick={() => requestKill(s)}>Kill</button>
          <button onclick={closeMenu}>Cancel</button>
        </div>
      {/if}

      {#if confirmKill === s.name}
        <div class="confirm">
          <span>Kill "{s.name}"? It is still running.</span>
          <button class="danger" onclick={() => { onKill(s.name); confirmKill = null; }}>Confirm</button>
          <button onclick={() => (confirmKill = null)}>Cancel</button>
        </div>
      {/if}
    </li>
  {/each}
  {#if sessions.length === 0}
    <li class="empty">No sessions. Tap ＋ to create one.</li>
  {/if}
</ul>

<style>
  .list { list-style: none; margin: 0; padding: 0; background: #151515; color: #ddd; }
  .row { display: flex; align-items: center; gap: 8px; width: 100%; border: 0;
         background: transparent; color: inherit; padding: 10px; text-align: left; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
  .dot-run { background: #2d4; } .dot-wait { background: #fd3; } .dot-done { background: #888; }
  .name { font-weight: 600; }
  .last { color: #888; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu, .confirm { display: flex; gap: 8px; padding: 8px 12px; background: #222; }
  .menu button, .confirm button { padding: 6px 10px; background: #333; color: #eee; border: 0; border-radius: 6px; }
  .danger { background: #a33 !important; color: #fff; }
  .empty { padding: 16px; color: #777; }
</style>
