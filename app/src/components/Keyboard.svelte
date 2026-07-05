<!-- app/src/components/Keyboard.svelte -->
<script lang="ts">
  import { LAYOUT, MOD_IDS, capFor } from "../lib/keymap";
  import { EMPTY_MODS, tapMod, activeMods, consumeAfterKey, resolveKey, type ModState, type ModName, type AppCommand } from "../lib/input-router";

  let { onText, onCommand, vibrate = false, layout = "mac", selecting = false, selCount = 0 }: {
    onText: (text: string) => void; onCommand: (c: AppCommand) => void;
    vibrate?: boolean; layout?: "mac" | "win"; selecting?: boolean; selCount?: number;
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
        {#if selecting}选区中 · {selCount} 字 · 方向键扩选{:else}方向键发送到程序 · 点「选区」开始选择{/if}
      </div>
      <div class="dpad">
        <button class="key" onpointerdown={(e) => { e.preventDefault(); press("ArrowUp"); }}>↑</button>
        <div class="dpad-mid">
          <button class="key" onpointerdown={(e) => { e.preventDefault(); press("ArrowLeft"); }}>←</button>
          <button class="key" onpointerdown={(e) => { e.preventDefault(); press("ArrowDown"); }}>↓</button>
          <button class="key" onpointerdown={(e) => { e.preventDefault(); press("ArrowRight"); }}>→</button>
        </div>
      </div>
      <div class="ops-grid">
        <button class="act" class:on={selecting}
          onclick={() => onCommand(selecting ? { type: "selCancel" } : { type: "selBegin" })}>{selecting ? "取消" : "选区"}</button>
        <button class="act" onclick={() => onCommand({ type: "selCopy" })}>复制选区</button>
        <button class="act" onclick={() => onCommand({ type: "copyAfter" })}>复制后续内容</button>
        <button class="act" onclick={() => onCommand({ type: "selectAllCopy" })}>全选并复制</button>
        <button class="act" onclick={() => onCommand({ type: "copyVisible" })}>复制可见屏</button>
        <button class="act" onclick={() => onCommand({ type: "paste" })}>粘贴</button>
      </div>
      <div class="ops-nav">
        <button class="key" onpointerdown={(e) => { e.preventDefault(); press("Home"); }}>Home</button>
        <button class="key" onpointerdown={(e) => { e.preventDefault(); press("End"); }}>End</button>
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
    gap: 8px;
    padding: 8px 10px;
    flex: 1;
    overflow-y: auto;
  }
  .ops-mode {
    font-size: 0.7rem;
    color: var(--dim);
    text-align: center;
  }
  .dpad {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .dpad-mid { display: flex; gap: 3px; }
  .dpad .key { min-width: 3em; }
  .ops-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
  }
  .ops-nav {
    display: flex;
    gap: 6px;
  }
  .ops-nav .key { flex: 1; }
  .act {
    background: var(--key);
    color: var(--text);
    border: 1px solid var(--key-line);
    border-radius: var(--radius-md);
    padding: 10px 0;
    font-size: 0.75rem;
  }
  .act.on {
    background: var(--teal);
    color: var(--teal-dark);
    border-color: var(--teal);
  }
</style>
