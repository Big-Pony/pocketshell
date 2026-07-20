<!-- app/src/components/Keyboard.svelte -->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { t } from "svelte-i18n";
  import { LAYOUT, FKEYS, ESC_KEY, MOD_IDS, capFor } from "../lib/keymap";
  import { EMPTY_MODS, tapMod, activeMods, consumeAfterKey, resolveKey, type ModState, type ModName, type AppCommand } from "../lib/input-router";
  import { createKeyRepeater, type KeyRepeater } from "../lib/key-repeat";
  import { imeSendText } from "../lib/ime-send";
  import type { VibrateLevel } from "../lib/settings";

  let { onText, onCommand, vibrate = "medium" as VibrateLevel, layout = "mac", hints = [], onHint = (_c: string) => {} }: {
    onText: (text: string) => void; onCommand: (c: AppCommand) => void;
    vibrate?: VibrateLevel; layout?: "mac" | "win";
    hints?: string[]; onHint?: (cmd: string) => void;
  } = $props();

  let sub = $state<"keys" | "ime" | "ops">("keys");
  let mods = $state<ModState>({ ...EMPTY_MODS });
  let imeBuf = $state("");

  const MODSET = new Set<string>(MOD_IDS);

  const VIBE_PATTERN: Record<VibrateLevel, number[]> = {
    off: [], light: [12], medium: [20], strong: [16, 8, 24],
  };
  function buzz() {
    const p = VIBE_PATTERN[vibrate];
    if (p.length) navigator.vibrate?.(p);
  }

  // Long-press repeaters keyed by keycap id (one per held key).
  const repeaters = new Map<string, KeyRepeater>();

  // One shot of a key: resolve against the CURRENT modifier state and emit.
  // Repeat ticks re-resolve, so an armed one-shot modifier (e.g. Shift) only
  // affects the first shot — holding "a" with Shift armed types "Aaaa…".
  function fireKey(id: string) {
    const r = resolveKey(id, activeMods(mods));
    if (r.kind === "bytes") onText(r.text);
    else if (r.kind === "command") onCommand(r.command);
    mods = consumeAfterKey(mods);
  }

  // Key down: modifiers toggle (no repeat); byte-producing keys fire once now
  // and arm a long-press repeater; app commands (Fn layer / Cmd shortcuts /
  // selection-mode arrows) fire once, exactly like before.
  function keyDown(id: string) {
    buzz(); // vibrate on keydown only — repeating it would be a constant hum
    if (MODSET.has(id)) { mods = tapMod(mods, id as ModName); return; }
    const r = resolveKey(id, activeMods(mods));
    if (r.kind !== "bytes") {
      if (r.kind === "command") onCommand(r.command);
      mods = consumeAfterKey(mods);
      return;
    }
    keyUp(id); // safety: drop a stale repeater for the same key
    const rep = createKeyRepeater(() => fireKey(id));
    repeaters.set(id, rep);
    rep.start(); // fires the first shot immediately
  }

  function keyUp(id: string) {
    const rep = repeaters.get(id);
    if (rep) { rep.stop(); repeaters.delete(id); }
  }

  onDestroy(() => {
    for (const rep of repeaters.values()) rep.stop();
    repeaters.clear();
  });

  function tapHint(cmd: string) {
    buzz();
    onHint(cmd);
  }

  function sendIme() {
    onText(imeSendText(imeBuf));
    imeBuf = "";
  }

  const isModOn = (id: string) => MODSET.has(id) && mods[id as ModName] !== "off";
  const isModLocked = (id: string) => MODSET.has(id) && mods[id as ModName] === "locked";

  function keyLabel(k: import("../lib/keymap").KeyCap): { main: string; upper?: string } {
    const main = capFor(k, layout);
    const shifted = activeMods(mods).shift;
    if (k.up) {
      return shifted ? { main: k.up, upper: main } : { main, upper: k.up };
    }
    return { main };
  }
</script>

<div class="kb">
  <div class="subtabs">
    <button class:on={sub === "keys"} onclick={() => (sub = "keys")}>{$t('keyboard.tab.keys')}</button>
    <button class:on={sub === "ime"} onclick={() => (sub = "ime")}>{$t('keyboard.tab.ime')}</button>
    <button class:on={sub === "ops"} onclick={() => (sub = "ops")}>{$t('keyboard.tab.ops')}</button>
  </div>

  {#if sub === "keys"}
    <div class="funcrow">
      <button class="key esc" data-key-id="Esc"
        onpointerdown={(e) => { e.preventDefault(); keyDown("Esc"); }}
        onpointerup={() => keyUp("Esc")}
        onpointercancel={() => keyUp("Esc")}
        onpointerleave={() => keyUp("Esc")}>{ESC_KEY.cap}</button>
      {#if isModOn("Fn")}
        <div class="fkeys">
          {#each FKEYS as k (k.id)}
            <button class="key fkey" data-key-id={k.id}
              onpointerdown={(e) => { e.preventDefault(); keyDown(k.id); }}
              onpointerup={() => keyUp(k.id)}
              onpointercancel={() => keyUp(k.id)}
              onpointerleave={() => keyUp(k.id)}>{k.cap}</button>
          {/each}
        </div>
      {:else}
        <div class="hints">
          {#each hints as h (h)}
            <button class="hint-chip" onpointerdown={(e) => { e.preventDefault(); tapHint(h); }}>{h}</button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="rows">
      {#each LAYOUT as row}
        <div class="row">
          {#each row as k (k.id)}
            {@const label = keyLabel(k)}
            {@const isMod = MODSET.has(k.id)}
            {@const on = isModOn(k.id)}
            {@const locked = isModLocked(k.id)}
            <button
              class="key"
              class:mod={isMod}
              class:on
              class:locked
              class:has-up={label.upper}
              data-key-id={k.id}
              style="flex-grow: {k.wide ?? 1};"
              onpointerdown={(e) => { e.preventDefault(); keyDown(k.id); }}
              onpointerup={() => keyUp(k.id)}
              onpointercancel={() => keyUp(k.id)}
              onpointerleave={() => keyUp(k.id)}
            >
              {#if label.upper}<span class="up">{label.upper}</span>{/if}
              <span class="main">{label.main}</span>
            </button>
          {/each}
        </div>
      {/each}
    </div>
  {:else if sub === "ime"}
    <div class="ime">
      <div class="target">{$t('keyboard.ime.target')}</div>
      <textarea bind:value={imeBuf} placeholder={$t('keyboard.ime.ph')} rows="3"></textarea>
      <div class="ime-actions">
        <button class="clear" onclick={() => (imeBuf = "")}>{$t('keyboard.ime.clear')}</button>
        <button class="send" onclick={sendIme}>{$t('keyboard.ime.send')}</button>
      </div>
      <div class="hint">{$t('keyboard.ime.hint')}</div>
    </div>
  {:else}
    <div class="ops">
      <div class="ops-row">
        <button class="key" data-key-id="Esc"
          onpointerdown={(e) => { e.preventDefault(); keyDown("Esc"); }}
          onpointerup={() => keyUp("Esc")} onpointercancel={() => keyUp("Esc")} onpointerleave={() => keyUp("Esc")}>Esc</button>
        <button class="key" data-key-id="Tab"
          onpointerdown={(e) => { e.preventDefault(); keyDown("Tab"); }}
          onpointerup={() => keyUp("Tab")} onpointercancel={() => keyUp("Tab")} onpointerleave={() => keyUp("Tab")}>Tab</button>
        <button class="key" data-key-id="Del"
          onpointerdown={(e) => { e.preventDefault(); keyDown("Del"); }}
          onpointerup={() => keyUp("Del")} onpointercancel={() => keyUp("Del")} onpointerleave={() => keyUp("Del")}>Del</button>
      </div>
      <div class="ops-main">
        <div class="dpad">
          <div></div>
          <button class="key up" onpointerdown={(e) => { e.preventDefault(); keyDown("ArrowUp"); }}
            onpointerup={() => keyUp("ArrowUp")} onpointercancel={() => keyUp("ArrowUp")} onpointerleave={() => keyUp("ArrowUp")}>↑</button>
          <div></div>
          <button class="key left" onpointerdown={(e) => { e.preventDefault(); keyDown("ArrowLeft"); }}
            onpointerup={() => keyUp("ArrowLeft")} onpointercancel={() => keyUp("ArrowLeft")} onpointerleave={() => keyUp("ArrowLeft")}>←</button>
          <button class="key enter-center" data-key-id="Enter" aria-label={$t('keyboard.ops.enterAria')}
            onpointerdown={(e) => { e.preventDefault(); keyDown("Enter"); }}
            onpointerup={() => keyUp("Enter")} onpointercancel={() => keyUp("Enter")} onpointerleave={() => keyUp("Enter")}>⏎</button>
          <button class="key right" onpointerdown={(e) => { e.preventDefault(); keyDown("ArrowRight"); }}
            onpointerup={() => keyUp("ArrowRight")} onpointercancel={() => keyUp("ArrowRight")} onpointerleave={() => keyUp("ArrowRight")}>→</button>
          <div></div>
          <button class="key down" onpointerdown={(e) => { e.preventDefault(); keyDown("ArrowDown"); }}
            onpointerup={() => keyUp("ArrowDown")} onpointercancel={() => keyUp("ArrowDown")} onpointerleave={() => keyUp("ArrowDown")}>↓</button>
          <div></div>
        </div>
        <div class="ops-nav2">
          <button class="key" onpointerdown={(e) => { e.preventDefault(); keyDown("Home"); }}
            onpointerup={() => keyUp("Home")} onpointercancel={() => keyUp("Home")} onpointerleave={() => keyUp("Home")}>Home</button>
          <button class="key" onpointerdown={(e) => { e.preventDefault(); keyDown("End"); }}
            onpointerup={() => keyUp("End")} onpointercancel={() => keyUp("End")} onpointerleave={() => keyUp("End")}>End</button>
          <button class="key" onpointerdown={(e) => { e.preventDefault(); keyDown("PgUp"); }}
            onpointerup={() => keyUp("PgUp")} onpointercancel={() => keyUp("PgUp")} onpointerleave={() => keyUp("PgUp")}>PgUp</button>
          <button class="key" onpointerdown={(e) => { e.preventDefault(); keyDown("PgDn"); }}
            onpointerup={() => keyUp("PgDn")} onpointercancel={() => keyUp("PgDn")} onpointerleave={() => keyUp("PgDn")}>PgDn</button>
        </div>
      </div>
      <div class="ops-bottom">
        <button class="act" onclick={() => onCommand({ type: "copyMode" })}>{$t('keyboard.ops.selectText')}</button>
        <button class="act" onclick={() => onCommand({ type: "selectAllCopy" })}>{$t('keyboard.ops.copyAll')}</button>
        <button class="act" onclick={() => onCommand({ type: "copyVisible" })}>{$t('keyboard.ops.copyOutput')}</button>
        <button class="act" onclick={() => onCommand({ type: "paste" })}>{$t('keyboard.ops.paste')}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .kb {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg);
    padding-bottom: var(--safe-bottom);
  }
  .subtabs {
    display: flex;
    gap: 4px;
    margin: 4px 8px;
    padding: 3px;
    flex: 0 0 auto;
    background: var(--seg-bg);
    border: 1px solid var(--seg-line);
    border-radius: 999px;
  }
  .subtabs button {
    flex: 1;
    background: transparent;
    color: var(--dim);
    border: 0;
    border-radius: 999px;
    padding: 6px 0;
    font-size: 0.68rem;
    transition: background 0.15s, color 0.15s;
  }
  .subtabs button.on {
    background: var(--seg-active-bg);
    color: var(--seg-active-text);
    font-weight: 600;
    box-shadow: var(--seg-shadow);
  }

  .funcrow {
    display: flex;
    gap: 3px;
    padding: 4px 4px 0;
    flex: 0 0 auto;
    align-items: stretch;
  }
  .funcrow .key.esc {
    flex: 0 0 auto;
    min-width: 3em;
    min-height: 2.3em;
    font-size: 0.62rem;
  }
  .fkeys {
    display: flex;
    gap: 3px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .fkeys::-webkit-scrollbar { display: none; }
  .fkeys .fkey {
    flex: 1 1 0;
    min-width: 2.4em;
    min-height: 2.3em;
    font-size: 0.62rem;
  }
  .hints {
    display: flex;
    gap: 4px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    align-items: center;
  }
  .hints::-webkit-scrollbar { display: none; }
  .hint-chip {
    flex: 0 0 auto;
    white-space: nowrap;
    background: var(--panel);
    color: var(--accent-text);
    border: 1px solid var(--line-soft);
    border-radius: 999px;
    padding: 5px 11px;
    font-size: 0.7rem;
    touch-action: none;
    user-select: none;
    min-height: 2.3em;
  }
  .hint-chip:active { background: var(--accent-soft); }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 4px;
    flex: 1;
    overflow-y: auto;
  }
  .row {
    display: flex;
    gap: 5px;
  }
  .key {
    flex: 1 1 0;
    min-width: 0;
    min-height: 2.3em;
    background: var(--key);
    background-image: var(--key-bg-image);
    color: var(--key-text);
    border: 1px solid var(--key-line);
    border-radius: var(--radius-sm);
    box-shadow: var(--key-shadow);
    padding: 4px 0;
    font-size: 0.72rem;
    touch-action: none;
    user-select: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    line-height: 1;
    transition: background 0.08s, border-color 0.08s, transform 0.05s;
    overflow: hidden;
  }
  .key:active {
    background: var(--keyhi);
    box-shadow: none;
    transform: translateY(1px);
  }
  .key.mod {
    background: var(--key-mod-bg);
    font-size: 0.58rem;
    color: var(--dim);
  }
  .key.mod.on {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
  }
  .key.mod.locked {
    background: var(--accent-soft);
    color: var(--accent-text);
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .key[data-key-id="Enter"] {
    background: var(--key-enter-bg);
    color: var(--key-enter-text);
    border-color: var(--key-enter-line);
    font-weight: 700;
  }
  .key .main {
    font-size: inherit;
  }
  .key .up {
    font-size: 0.55rem;
    color: var(--dim);
    line-height: 1;
  }
  .key.has-up {
    padding-top: 2px;
  }

  .ime {
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    overflow-y: auto;
  }
  .target {
    font-size: 0.7rem;
    color: var(--dim);
  }
  .ime textarea {
    width: 100%;
    box-sizing: border-box;
    background: var(--panel2);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    color: var(--text);
    padding: 10px;
    font-size: 0.85rem;
    resize: none;
    font-family: inherit;
    outline: none;
  }
  .ime textarea:focus {
    border-color: var(--accent);
  }
  .ime-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .ime-actions button {
    border: 0;
    border-radius: var(--radius-md);
    padding: 8px 14px;
    font-size: 0.78rem;
  }
  .ime-actions .send {
    background: var(--primary-bg);
    color: var(--primary-text);
    font-weight: 600;
    flex: 1;
  }
  .ime-actions .clear {
    background: var(--key);
    color: var(--text);
  }
  .hint {
    font-size: 0.68rem;
    color: var(--dim);
    line-height: 1.6;
  }
  .ops {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px;
    flex: 1;
    overflow-y: auto;
  }
  .ops-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
  }
  .ops-row .key { min-height: 2.6em; font-size: 0.74rem; }
  .ops-main {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .dpad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-template-rows: repeat(3, 1fr);
    grid-template-areas:
      ". up ."
      "left toggle right"
      ". down .";
    gap: 4px;
    flex: 1 1 0;
  }
  .dpad .up { grid-area: up; }
  .dpad .left { grid-area: left; }
  .dpad .right { grid-area: right; }
  .dpad .down { grid-area: down; }
  .dpad .key {
    min-height: 3em;
    font-size: 0.8rem;
    padding: 0 2px;
  }
  .dpad .enter-center {
    grid-area: toggle;
    background: var(--key-enter-bg);
    color: var(--key-enter-text);
    border-color: var(--key-enter-line);
    font-weight: 700;
  }
  .ops-nav2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 4px;
    flex: 1 1 0;
  }
  .ops-nav2 .key { min-height: 3em; font-size: 0.75rem; }
  .ops-bottom {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
  }
  .ops-bottom .act {
    padding: 10px 0;
    font-size: 0.72rem;
  }
  .act {
    background: var(--key);
    color: var(--key-text);
    border: 1px solid var(--key-line);
    border-radius: var(--radius-md);
    padding: 6px 0;
    font-size: 0.72rem;
  }
</style>
