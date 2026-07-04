<!-- app/src/components/Keyboard.svelte -->
<script lang="ts">
  import { LAYOUT, MOD_IDS } from "../lib/keymap";
  import { EMPTY_MODS, tapMod, activeMods, consumeAfterKey, resolveKey, type ModState, type ModName, type AppCommand } from "../lib/input-router";

  let { onText, onCommand, vibrate = false }: {
    onText: (text: string) => void; onCommand: (c: AppCommand) => void; vibrate?: boolean;
  } = $props();

  let sub = $state<"keys" | "ime">("keys");
  let mods = $state<ModState>({ ...EMPTY_MODS });
  let imeBuf = $state("");

  const MODSET = new Set<string>(MOD_IDS);

  function buzz() { if (vibrate) navigator.vibrate?.(8); }

  function press(id: string) {
    buzz();
    if (MODSET.has(id)) { mods = tapMod(mods, id as ModName); return; }
    const r = resolveKey(id, activeMods(mods));
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
</script>

<div class="kb">
  <div class="subtabs">
    <button class:on={sub === "keys"} onclick={() => (sub = "keys")}>全键盘</button>
    <button class:on={sub === "ime"} onclick={() => (sub = "ime")}>输入法缓冲</button>
  </div>

  {#if sub === "keys"}
    <div class="rows">
      {#each LAYOUT as row}
        <div class="row">
          {#each row as k (k.id)}
            <button
              class="key"
              class:mod={MODSET.has(k.id)}
              class:on={isModOn(k.id)}
              class:locked={isModLocked(k.id)}
              style="flex-grow: {k.wide ?? 1};"
              onpointerdown={(e) => { e.preventDefault(); press(k.id); }}
            >{k.cap}</button>
          {/each}
        </div>
      {/each}
    </div>
  {:else}
    <div class="ime">
      <textarea bind:value={imeBuf} placeholder="用系统输入法编辑整段（中文/长指令），点发送一次性注入终端" rows="3"></textarea>
      <div class="ime-actions">
        <button onclick={() => (imeBuf = "")}>清空</button>
        <button class="send" onclick={sendIme}>发送 ⏎</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .kb { display: flex; flex-direction: column; height: 100%; background: #0a0a0a; }
  .subtabs { display: flex; gap: 8px; padding: 4px 8px; }
  .subtabs button { background: #1a1a1a; color: #aaa; border: 0; border-radius: 6px; padding: 4px 10px; font-size: 12px; }
  .subtabs button.on { background: #2d4; color: #000; }
  .rows { display: flex; flex-direction: column; gap: 4px; padding: 4px; flex: 1; }
  .row { display: flex; gap: 4px; }
  .key { flex: 1 1 0; min-width: 0; background: #222; color: #eee; border: 0; border-radius: 5px;
         padding: 8px 0; font-size: 13px; touch-action: none; user-select: none; }
  .key.mod { background: #333; font-size: 11px; }
  .key.on { background: #2d4; color: #000; }
  .key.locked { background: #4a8; color: #000; box-shadow: inset 0 0 0 2px #fff6; }
  .ime { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
  .ime textarea { width: 100%; box-sizing: border-box; background: #111; color: #eee; border: 1px solid #333; border-radius: 6px; }
  .ime-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .ime-actions .send { background: #2d4; color: #000; border: 0; border-radius: 6px; padding: 6px 14px; }
  .ime-actions button { background: #333; color: #eee; border: 0; border-radius: 6px; padding: 6px 14px; }
</style>
