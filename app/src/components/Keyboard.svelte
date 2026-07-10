<!-- app/src/components/Keyboard.svelte -->
<script lang="ts">
  import { LAYOUT, FKEYS, ESC_KEY, SEQ, MOD_IDS, capFor } from "../lib/keymap";
  import { EMPTY_MODS, tapMod, activeMods, consumeAfterKey, resolveKey, type ModState, type ModName, type AppCommand } from "../lib/input-router";

  let { onText, onCommand, vibrate = false, layout = "mac", selecting = false, selCount = 0, selMode = "idle", hints = [], onHint = (_c: string) => {} }: {
    onText: (text: string) => void; onCommand: (c: AppCommand) => void;
    vibrate?: boolean; layout?: "mac" | "win"; selecting?: boolean; selCount?: number;
    selMode?: "idle" | "selecting" | "line";
    hints?: string[]; onHint?: (cmd: string) => void;
  } = $props();

  let sub = $state<"keys" | "ime" | "ops">("keys");
  let mods = $state<ModState>({ ...EMPTY_MODS });
  let imeBuf = $state("");

  const MODSET = new Set<string>(MOD_IDS);

  function buzz() { if (vibrate) navigator.vibrate?.(8); }

  function press(id: string) {
    buzz();
    if (MODSET.has(id)) { mods = tapMod(mods, id as ModName); return; }
    const r = resolveKey(id, activeMods(mods), selecting);
    if (r.kind === "bytes") onText(r.text);
    else if (r.kind === "command") onCommand(r.command);
    mods = consumeAfterKey(mods);
  }

  function pressEsc() {
    buzz();
    onText(SEQ.Esc);
    mods = consumeAfterKey(mods);
  }
  function tapHint(cmd: string) {
    buzz();
    onHint(cmd);
  }

  function sendIme() {
    if (!imeBuf) return;
    onText(imeBuf + "\r");
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
    <button class:on={sub === "keys"} onclick={() => (sub = "keys")}>⌨ 全键盘</button>
    <button class:on={sub === "ime"} onclick={() => (sub = "ime")}>✎ 输入法缓冲</button>
    <button class:on={sub === "ops"} onclick={() => (sub = "ops")}>✂ 快捷操作</button>
  </div>

  {#if sub === "keys"}
    <div class="funcrow">
      <button class="key esc" data-key-id="Esc"
        onpointerdown={(e) => { e.preventDefault(); pressEsc(); }}>{ESC_KEY.cap}</button>
      {#if isModOn("Fn")}
        <div class="fkeys">
          {#each FKEYS as k (k.id)}
            <button class="key fkey" data-key-id={k.id}
              onpointerdown={(e) => { e.preventDefault(); press(k.id); }}>{k.cap}</button>
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
              onpointerdown={(e) => { e.preventDefault(); press(k.id); }}
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
      <div class="target">发送到当前会话 · 用系统输入法编辑整段后一次性注入</div>
      <textarea bind:value={imeBuf} placeholder="例如：帮我给登录接口加上基于 IP 的限流，每分钟最多 20 次…" rows="3"></textarea>
      <div class="ime-actions">
        <button class="clear" onclick={() => (imeBuf = "")}>清空</button>
        <button class="send" onclick={sendIme}>发送到终端 ⏎</button>
      </div>
      <div class="hint">发送前内容只存在于本地缓冲区，断线也不丢失。</div>
    </div>
  {:else}
    <div class="ops">
      <div class="ops-mode">
        {#if selMode === "line"}选行中 · {selCount} 行 · 上一行/下一行扩选{:else if selMode === "selecting"}选区中 · {selCount} 字 · 方向键扩选{:else}方向键发送到程序 · 点「选区」或「上/下一行」开始{/if}
      </div>
      <div class="ops-main">
        <div class="dpad">
          <div></div>
          <button class="key up" onpointerdown={(e) => { e.preventDefault(); press("ArrowUp"); }}>↑</button>
          <div></div>
          <button class="key left" onpointerdown={(e) => { e.preventDefault(); press("ArrowLeft"); }}>←</button>
          <button class="act toggle" class:on={selecting}
            onclick={() => onCommand(selecting ? { type: "selCancel" } : { type: "selBegin" })}>{selecting ? "取消" : "选区"}</button>
          <button class="key right" onpointerdown={(e) => { e.preventDefault(); press("ArrowRight"); }}>→</button>
          <div></div>
          <button class="key down" onpointerdown={(e) => { e.preventDefault(); press("ArrowDown"); }}>↓</button>
          <div></div>
        </div>
        <div class="ops-side">
          <button class="act line" onclick={() => onCommand({ type: "lineUp" })}>上一行</button>
          <button class="act line" onclick={() => onCommand({ type: "lineDown" })}>下一行</button>
          <button class="key" onpointerdown={(e) => { e.preventDefault(); press("Home"); }}>Home</button>
          <button class="key" onpointerdown={(e) => { e.preventDefault(); press("End"); }}>End</button>
          <button class="enter-fab" aria-label="确认（回车）"
            onpointerdown={(e) => { e.preventDefault(); press("Enter"); }}>确认</button>
        </div>
      </div>
      <div class="ops-bottom">
        <button class="act" onclick={() => onCommand({ type: "selCopy" })}>复制选区</button>
        <button class="act" onclick={() => onCommand({ type: "copyAfter" })}>复制后续</button>
        <button class="act" onclick={() => onCommand({ type: "selectAllCopy" })}>全选复制</button>
        <button class="act" onclick={() => onCommand({ type: "copyVisible" })}>复制输出</button>
        <button class="act" onclick={() => onCommand({ type: "paste" })}>粘贴</button>
      </div>
      <div class="ops-nav">
        <button class="key" onpointerdown={(e) => { e.preventDefault(); press("PgUp"); }}>PgUp</button>
        <button class="key" onpointerdown={(e) => { e.preventDefault(); press("PgDn"); }}>PgDn</button>
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
    padding: 4px 8px;
    flex: 0 0 auto;
  }
  .subtabs button {
    flex: 1;
    background: var(--key);
    color: var(--dim);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 5px 0;
    font-size: 0.68rem;
    transition: background 0.15s, color 0.15s;
  }
  .subtabs button.on {
    background: var(--panel2);
    color: var(--teal);
    border-color: var(--line-strong);
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
    background: var(--key);
    color: var(--teal);
    border: 1px solid var(--key-line);
    border-radius: var(--radius-md);
    padding: 5px 10px;
    font-size: 0.7rem;
    touch-action: none;
    user-select: none;
    min-height: 2.3em;
  }
  .hint-chip:active { background: var(--keyhi); }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 4px;
    flex: 1;
    overflow-y: auto;
  }
  .row {
    display: flex;
    gap: 3px;
  }
  .key {
    flex: 1 1 0;
    min-width: 0;
    min-height: 2.3em;
    background: var(--key);
    color: var(--text);
    border: 1px solid var(--key-line);
    border-bottom-width: 2px;
    border-radius: var(--radius-sm);
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
    border-bottom-width: 1px;
    transform: translateY(1px);
  }
  .key.mod {
    background: #2a3540;
    font-size: 0.58rem;
    color: var(--dim);
  }
  .key.mod.on {
    background: var(--teal);
    color: var(--teal-dark);
    border-color: var(--teal);
  }
  .key.mod.locked {
    background: #3a8c7a;
    color: var(--teal-dark);
    border-color: var(--teal);
    box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.25);
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
    border-color: var(--teal);
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
    background: var(--teal);
    color: var(--teal-dark);
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
  .ops-mode {
    font-size: 0.65rem;
    color: var(--dim);
    text-align: center;
  }
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
  .dpad .toggle { grid-area: toggle; }
  .dpad .key,
  .dpad .toggle {
    min-height: 3em;
    font-size: 0.8rem;
    padding: 0 2px;
  }
  .ops-side {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 4px;
    flex: 1 1 0;
    position: relative;
  }
  .enter-fab {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 3.9em;
    height: 3.9em;
    border-radius: 50%;
    background: var(--teal);
    color: var(--teal-dark);
    border: 2px solid var(--bg);
    font-size: 0.94rem;
    font-weight: 600;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    touch-action: none;
    user-select: none;
  }
  .enter-fab:active { filter: brightness(0.92); }
  .ops-side .act,
  .ops-side .key {
    min-height: 3em;
    font-size: 0.75rem;
    padding: 0 2px;
  }
  .ops-bottom {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 4px;
  }
  .ops-bottom .act {
    padding: 10px 0;
    font-size: 0.72rem;
  }
  .ops-nav {
    display: flex;
    gap: 4px;
  }
  .ops-nav .key { flex: 1; min-height: 2.6em; font-size: 0.72rem; }
  .act {
    background: var(--key);
    color: var(--text);
    border: 1px solid var(--key-line);
    border-radius: var(--radius-md);
    padding: 6px 0;
    font-size: 0.72rem;
  }
  .act.on {
    background: var(--teal);
    color: var(--teal-dark);
    border-color: var(--teal);
  }
</style>
