<script lang="ts">
  import { t } from "svelte-i18n";
  import { stateDotClass } from "../lib/ui/session-view";
  import { stepTap, TAP_RESET, TAP_WINDOW_MS, type TapState } from "../lib/ui/top-tabs";
  import type { SessionState } from "../lib/net/protocol";

  type TabView =
    | { kind: "term"; id: string; title: string; state: SessionState; closed: boolean; shell: boolean }
    | { kind: "file"; id: string; title: string; path: string };

  let { tabs, activeId, onSelect, onNew, onCloseTab, onCopyPath, dirtyIds }: {
    tabs: TabView[]; activeId: string;
    onSelect: (id: string) => void;
    onNew: (name: string, kind: "tmux" | "shell") => void;
    onCloseTab: (id: string) => void;
    onCopyPath?: (id: string) => void;
    dirtyIds?: Set<string>;
  } = $props();

  // New-session modal
  let adding = $state(false);
  let draft = $state("");
  let draftKind = $state<"tmux" | "shell">("tmux");
  function openAdd() { draft = ""; draftKind = "tmux"; adding = true; }
  function submitAdd() {
    const name = draft.trim();
    if (name) onNew(name, draftKind);
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

  // Tap gestures (requirement 11): single tap = select (immediate), double =
  // close, triple (file tabs only) = copy absolute path. The FSM lives in
  // stepTap (pure, unit-tested in top-tabs.test.ts); this component only runs
  // its side effects. Long-press was removed because on phones it fires the
  // native text-selection / callout menu.
  //
  // Because a double tap must not preempt a possible third, closing a file tab
  // is DEFERRED: the 2nd tap schedules closeTimer; a 3rd tap within the window
  // clears it and copies instead. Term tabs (no third action) close at once.
  let downId = "";
  let downX = 0;
  let downY = 0;
  let tapState: TapState = TAP_RESET;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  function clearCloseTimer() { if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined; } }
  function openClose(tab: TabView, at: number) { closing = tab; closingAt = at; }

  function onTabDown(e: PointerEvent, t: TabView) {
    downId = t.id; downX = e.clientX; downY = e.clientY;
  }
  function onTabUp(e: PointerEvent, t: TabView) {
    if (downId !== t.id) { downId = ""; return; } // released off the tab it started on
    downId = "";
    const dragged = Math.abs(e.clientX - downX) > 8 || Math.abs(e.clientY - downY) > 8;
    const now = e.timeStamp;
    // Any new tap cancels a pending deferred close (stale tab, or the 3rd tap).
    clearCloseTimer();
    const { state, action } = stepTap(tapState, { id: t.id, kind: t.kind, t: now, dragged });
    tapState = state;
    switch (action.type) {
      case "select": onSelect(t.id); break;
      case "deferClose": closeTimer = setTimeout(() => { closeTimer = undefined; openClose(t, e.timeStamp + TAP_WINDOW_MS); }, TAP_WINDOW_MS); break;
      case "closeNow": openClose(t, now); break;
      case "copy": onCopyPath?.(t.id); break;
      case "none": break;
    }
  }
  function onTabCancel() { downId = ""; tapState = TAP_RESET; clearCloseTimer(); }

  function autoFocus(node: HTMLElement) { node.focus(); }

  // Hoisted out of the tab loop on purpose: `{#each tabs as t}` shadows the
  // svelte-i18n `t` store, so `$t(...)` inside the loop body resolves to the
  // loop variable, not the store. Deriving it here keeps locale reactivity.
  const closeLabel = $derived($t('tabs.ariaClose'));

  let strip = $state<HTMLElement | null>(null);
  // First scroll (e.g. a restored far-right active tab on mount) jumps instantly;
  // later scrolls animate.
  let firstScroll = true;
  // When the active tab changes, scroll it flush-left so it's always visible.
  // Ordering is NOT changed — this is scroll-only (requirement 6).
  $effect(() => {
    const id = activeId; // track
    if (!strip) return;
    const el = strip.querySelector<HTMLElement>(".tab.active");
    if (el) {
      // Use bounding-rect deltas rather than el.offsetLeft: offsetLeft is
      // relative to the offsetParent (.tabs-wrap, position:relative in
      // App.svelte), not to .strip itself, so it includes that ancestor's
      // padding and overshoots the scroll. Rect deltas are relative to the
      // viewport, so they're correct regardless of offsetParent/CSS position.
      const delta = el.getBoundingClientRect().left - strip.getBoundingClientRect().left;
      strip.scrollTo({ left: strip.scrollLeft + delta, behavior: firstScroll ? "auto" : "smooth" });
      firstScroll = false;
    }
  });
</script>

<div class="toptabs">
  <nav class="strip" bind:this={strip}>
    {#each tabs as t (t.id)}
      <button
        class="tab"
        class:active={t.id === activeId}
        class:closed={t.kind === "term" && t.closed}
        onpointerdown={(e) => onTabDown(e, t)}
        onpointerup={(e) => onTabUp(e, t)}
        onpointercancel={onTabCancel}
      >
        {#if t.kind === "term"}
          {#if t.shell}<span class="sh-glyph mono">❯</span>{:else}<span class="dot {stateDotClass(t.state)}"></span>{/if}
        {/if}
        <span class="name">{t.title}</span>
        {#if t.id === activeId}
          <!-- 显式关闭钮：降低对三击手势的依赖，手势 FSM 原样保留。
               stopPropagation 让它不进 stepTap，否则一次点击会既开确认框
               又被记成一次 tap。 -->
          <span class="x mono" role="button" tabindex="0" aria-label={closeLabel}
            onpointerdown={(e) => e.stopPropagation()}
            onpointerup={(e) => { e.stopPropagation(); onTabCancel(); openClose(t, e.timeStamp); }}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openClose(t, e.timeStamp); } }}
          >×</span>
        {/if}
      </button>
    {/each}
  </nav>
  <div class="ops">
    <button class="add" aria-label={$t('tabs.ariaNew')} onclick={openAdd}>＋</button>
  </div>
</div>

{#if adding}
  <div class="overlay" role="presentation" onclick={() => (adding = false)}>
    <div class="dlg" role="dialog" aria-modal="true" aria-label={$t('tabs.ariaNew')} tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === "Escape") adding = false; }}>
      <div class="dlg-title">{$t('tabs.newTitle')}</div>
      <div class="kind-seg">
        <button class:on={draftKind === "tmux"} onclick={() => (draftKind = "tmux")}>tmux</button>
        <button class:on={draftKind === "shell"} onclick={() => (draftKind = "shell")}>{$t('tabs.kindShell')}</button>
      </div>
      <input class="dlg-input" use:autoFocus bind:value={draft} placeholder={$t('tabs.namePh')}
        onkeydown={(e) => { if (e.key === "Enter") submitAdd(); if (e.key === "Escape") adding = false; }} />
      <div class="dlg-btns">
        <button onclick={() => (adding = false)}>{$t('common.cancel')}</button>
        <button class="primary" onclick={submitAdd}>{$t('common.confirm')}</button>
      </div>
    </div>
  </div>
{/if}

{#if closing}
  <div class="overlay" role="presentation" onclick={dismissClose}>
    <div class="dlg" role="dialog" aria-modal="true" aria-label={$t('tabs.ariaClose')} tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === "Escape") closing = null; }}>
      <div class="dlg-title">{$t('tabs.closeTitle', { values: { title: closing.title } })}</div>
      <div class="dlg-hint">
        {closing.kind === "term" ? (closing.shell ? $t('tabs.closeShellHint') : $t('tabs.closeTermHint')) : $t('tabs.closeFileHint')}
        {#if closing.kind === "file" && dirtyIds?.has(closing.id)}
          <div class="dirty-warn">{$t('tabs.closeDirty')}</div>
        {/if}
      </div>
      <div class="dlg-btns">
        <button onclick={() => (closing = null)}>{$t('common.cancel')}</button>
        <button class="primary" onclick={confirmClose}>{$t('common.confirm')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* flex:1 + min-width:0 so this fills .tabs-wrap and lets .strip actually
     overflow-scroll; without it the content width pushes .ops (the +) past the
     parent's overflow:hidden edge and off-screen. */
  /* 索引卡片式 tab：卡片底边压在 .toptabs 的下边线上，激活态与终端底同色，
     视觉上「卡片连着终端」。align-items:flex-end 让卡片贴着这条线长上去。 */
  .toptabs {
    display: flex; align-items: flex-end; gap: 3px;
    background: transparent; padding: 5px 10px 0;
    border-bottom: 1px solid var(--tab-line);
    flex: 1; min-width: 0; width: 100%;
  }
  /* margin-bottom:-1px 让 strip 自身向下盖住 .toptabs 的下边线，卡片贴着
     strip 底边（align-items:flex-end）因而正好压在线上，与终端连成一体。
     不能改用卡片 `position:relative; top:1px` 下移——strip 有 overflow-x:auto，
     溢出的那 1px 会被裁掉，分隔线反而横穿卡片。 */
  .strip {
    display: flex; align-items: flex-end; gap: 3px; flex: 1; min-width: 0;
    overflow-x: auto; scrollbar-width: none; scroll-snap-type: x mandatory;
    margin-bottom: -1px;
  }
  .strip::-webkit-scrollbar { display: none; }
  .ops { flex: 0 0 auto; }
  .tab {
    flex: none; display: flex; align-items: center; gap: 7px;
    padding: 6px 13px 7px; border: 1px solid transparent; border-bottom: none;
    border-radius: 6px 6px 0 0; background: var(--tab-bg); color: var(--dim);
    font-size: 0.72rem; white-space: nowrap; scroll-snap-align: start;
    position: relative;
    transition: background 0.15s, color 0.15s;
    /* Multi-tap must not raise the phone's native selection / callout menu. */
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .tab.active { background: var(--tab-active-bg); color: var(--tab-active-text); border-color: var(--tab-active-line); }
  /* 激活态顶部 2px 橙线 */
  .tab.active::after {
    content: ""; position: absolute; top: 0; left: 10px; right: 10px;
    height: 2px; border-radius: 0 0 2px 2px; background: var(--tab-idx-top);
  }
  .tab.closed { opacity: 0.7; }
  .x {
    color: var(--dim); font-size: 0.85rem; line-height: 1;
    margin: -2px -6px -2px 0; padding: 3px 5px;
  }
  .x:active { color: var(--text); }
  .dot { width: 6px; height: 6px; border-radius: 50%; }
  .dot-run { background: var(--ok); box-shadow: 0 0 5px var(--ok); animation: pulse 1.4s infinite; }
  .dot-wait { background: var(--amber); animation: pulse 1s infinite; }
  .dot-done { background: var(--dimmer); }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
  .add {
    flex: none; background: transparent; border: 0;
    color: var(--dim); width: 30px; height: 30px;
    padding: 0 0 6px; font-size: 1rem; line-height: 1;
    font-family: var(--font-mono);
  }
  .add:active { color: var(--text); }

  .overlay { position: fixed; inset: 0; z-index: 40; background: var(--overlay-bg); display: flex; justify-content: center; align-items: flex-start; }
  .overlay .dlg { margin-top: 14vh; }
  .kind-seg { display: flex; gap: 2px; background: var(--seg-bg); border: 1px solid var(--seg-line); border-radius: 999px; padding: 2px; margin-bottom: 12px; }
  .kind-seg button { flex: 1; background: transparent; border: 0; color: var(--dim); padding: 6px 0; font-size: 0.72rem; border-radius: 999px; }
  .kind-seg button.on { background: var(--seg-active-bg); color: var(--seg-active-text); font-weight: 600; box-shadow: var(--seg-shadow); }
  .sh-glyph { color: var(--accent); font-size: 0.7rem; }
  .dlg { background: var(--dlg-bg); border: 1px solid var(--line); border-radius: var(--radius-xl); padding: 20px; width: min(280px, 82vw); text-align: center; box-shadow: var(--pop-shadow); }
  .dlg-title { font-size: 0.85rem; font-weight: 700; margin-bottom: 10px; }
  .dlg-hint { font-size: 0.7rem; color: var(--dim); margin-bottom: 14px; line-height: 1.5; }
  .dlg-input { width: 100%; box-sizing: border-box; background: var(--panel2); border: 1px solid var(--line-strong); border-radius: var(--radius-md); color: var(--text); padding: 8px 10px; font-size: 0.8rem; margin-bottom: 14px; outline: none; }
  .dlg-input:focus { border-color: var(--accent); }
  .dlg-btns { display: flex; gap: 8px; }
  .dlg-btns button { flex: 1; padding: 9px 0; border-radius: var(--radius-md); border: 1px solid var(--line); font-size: 0.75rem; background: var(--key); color: var(--text); }
  .dirty-warn { color: var(--amber); font-size: 0.7rem; margin-top: 6px; }
  .dlg-btns button.primary { background: var(--primary-bg); color: var(--primary-text); border-color: transparent; font-weight: 600; }
</style>
