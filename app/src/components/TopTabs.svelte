<script lang="ts">
  import { stateDotClass } from "../lib/session-view";
  import type { SessionState } from "../lib/protocol";

  type TabView =
    | { kind: "term"; id: string; title: string; state: SessionState; closed: boolean }
    | { kind: "file"; id: string; title: string };

  let { tabs, activeId, onSelect, onNew, onCloseTab }: {
    tabs: TabView[]; activeId: string;
    onSelect: (id: string) => void;
    onNew: (name: string) => void;
    onCloseTab: (id: string) => void;
  } = $props();

  // New-session modal
  let adding = $state(false);
  let draft = $state("");
  function openAdd() { draft = ""; adding = true; }
  function submitAdd() {
    const name = draft.trim();
    if (name) onNew(name);
    adding = false;
  }

  // Close-confirm modal
  let closing = $state<TabView | null>(null);
  let closingAt = 0; // when the modal opened; ignore the ghost click double-tap synthesizes
  function confirmClose() {
    if (closing) onCloseTab(closing.id);
    closing = null;
  }
  function dismissClose(e: Event) {
    // The double-tap that opened this modal synthesizes a trailing mouse click
    // on the overlay (~<350ms later). Ignore it so the modal doesn't vanish.
    if (e.timeStamp - closingAt < 350) return;
    closing = null;
  }

  // Single tap selects immediately (no latency); double tap on the SAME tab
  // opens the close dialog. Track the pointer-down position so a horizontal
  // scroll/drag of the strip is not mistaken for a tap. Keyed by tab id so
  // tapping two different tabs quickly is two selects, not a false "close".
  let downId = "";
  let downX = 0;
  let downY = 0;
  let lastTapId = "";
  let lastTapAt = 0;
  function onTabDown(e: PointerEvent, t: TabView) { downId = t.id; downX = e.clientX; downY = e.clientY; }
  function onTabUp(e: PointerEvent, t: TabView) {
    if (downId !== t.id) return; // released off the tab it started on
    downId = "";
    if (Math.abs(e.clientX - downX) > 8 || Math.abs(e.clientY - downY) > 8) { lastTapId = ""; return; } // a scroll/drag, not a tap
    const now = e.timeStamp;
    if (lastTapId === t.id && now - lastTapAt < 300) { lastTapId = ""; lastTapAt = 0; closing = t; closingAt = now; return; }
    lastTapId = t.id;
    lastTapAt = now;
    onSelect(t.id);
  }

  function autoFocus(node: HTMLElement) { node.focus(); }
</script>

<div class="toptabs">
  <nav class="strip">
    {#each tabs as t (t.id)}
      <button
        class="tab"
        class:file={t.kind === "file"}
        class:active={t.id === activeId}
        class:closed={t.kind === "term" && t.closed}
        onpointerdown={(e) => onTabDown(e, t)}
        onpointerup={(e) => onTabUp(e, t)}
      >
        {#if t.kind === "term"}<span class="dot {stateDotClass(t.state)}"></span>{/if}
        <span class="name">{t.title}</span>
      </button>
    {/each}
  </nav>
  <div class="ops">
    <button class="add" aria-label="new session" onclick={openAdd}>＋</button>
  </div>
</div>

{#if adding}
  <div class="overlay" role="presentation" onclick={() => (adding = false)}>
    <div class="dlg" role="dialog" aria-modal="true" aria-label="新建会话" tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === "Escape") adding = false; }}>
      <div class="dlg-title">新建终端会话</div>
      <input class="dlg-input" use:autoFocus bind:value={draft} placeholder="会话名称"
        onkeydown={(e) => { if (e.key === "Enter") submitAdd(); if (e.key === "Escape") adding = false; }} />
      <div class="dlg-btns">
        <button onclick={() => (adding = false)}>取消</button>
        <button class="primary" onclick={submitAdd}>确认</button>
      </div>
    </div>
  </div>
{/if}

{#if closing}
  <div class="overlay" role="presentation" onclick={dismissClose}>
    <div class="dlg" role="dialog" aria-modal="true" aria-label="关闭标签" tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === "Escape") closing = null; }}>
      <div class="dlg-title">关闭「{closing.title}」？</div>
      <div class="dlg-hint">
        {closing.kind === "term" ? "仅关闭标签，会话仍在后台运行，可从任务面板重新打开。" : "关闭该文件预览标签。"}
      </div>
      <div class="dlg-btns">
        <button onclick={() => (closing = null)}>取消</button>
        <button class="primary" onclick={confirmClose}>确认</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* flex:1 + min-width:0 so this fills .tabs-wrap and lets .strip actually
     overflow-scroll; without it the content width pushes .ops (the +) past the
     parent's overflow:hidden edge and off-screen. */
  .toptabs { display: flex; align-items: center; gap: 6px; background: var(--bg); padding: 0 8px 8px; flex: 1; min-width: 0; width: 100%; }
  .strip { display: flex; gap: 6px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; scroll-snap-type: x mandatory; }
  .strip::-webkit-scrollbar { display: none; }
  .ops { flex: 0 0 auto; }
  .tab {
    flex: none; display: flex; align-items: center; gap: 6px;
    padding: 5px 11px; border: 1px solid var(--line); border-bottom: none;
    border-radius: 8px 8px 0 0; background: var(--panel); color: var(--dim);
    font-size: 0.74rem; white-space: nowrap; scroll-snap-align: start;
    transition: background 0.15s, color 0.15s;
  }
  .tab.active { background: var(--panel2); color: var(--text); border-color: var(--line-strong); }
  /* File tabs share the tmux tab shape but get a distinct border colour. */
  .tab.file { border-color: var(--teal); }
  .tab.file.active { border-color: var(--teal); color: var(--teal); }
  .tab.closed { opacity: 0.7; }
  .dot { width: 6px; height: 6px; border-radius: 50%; }
  .dot-run { background: var(--teal); animation: pulse 1.4s infinite; }
  .dot-wait { background: var(--amber); animation: pulse 1s infinite; }
  .dot-done { background: var(--dimmer); }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
  .add {
    flex: none; background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius-md); color: var(--text); padding: 5px 12px; font-size: 0.9rem;
  }
  .add:active { background: var(--key); }

  .overlay { position: fixed; inset: 0; z-index: 40; background: rgba(7, 9, 11, 0.75); display: grid; place-items: center; }
  .dlg { background: #1c2530; border: 1px solid var(--line); border-radius: 14px; padding: 20px; width: min(280px, 82vw); text-align: center; }
  .dlg-title { font-size: 0.85rem; font-weight: 700; margin-bottom: 10px; }
  .dlg-hint { font-size: 0.7rem; color: var(--dim); margin-bottom: 14px; line-height: 1.5; }
  .dlg-input { width: 100%; box-sizing: border-box; background: var(--panel2); border: 1px solid var(--line-strong); border-radius: var(--radius-md); color: var(--text); padding: 8px 10px; font-size: 0.8rem; margin-bottom: 14px; outline: none; }
  .dlg-btns { display: flex; gap: 8px; }
  .dlg-btns button { flex: 1; padding: 9px 0; border-radius: var(--radius-md); border: 1px solid var(--line); font-size: 0.75rem; background: var(--key); color: var(--text); }
  .dlg-btns button.primary { background: var(--teal); color: var(--teal-dark); border-color: transparent; font-weight: 600; }
</style>
