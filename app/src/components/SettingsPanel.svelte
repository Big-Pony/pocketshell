<!-- app/src/components/SettingsPanel.svelte -->
<script lang="ts">
  import type { Connection } from "../lib/connection";
  import type { Settings } from "../lib/settings";
  import DeviceManager from "./DeviceManager.svelte";

  // Controlled: App owns the settings state (and applies them to terminals /
  // keyboard); this panel only renders and reports changes via onChange.
  let { conn, settings, onChange }: {
    conn: Connection; settings: Settings; onChange: (s: Settings) => void;
  } = $props();

  function update<K extends keyof Settings>(k: K, v: Settings[K]) {
    onChange({ ...settings, [k]: v });
  }

  let showDevices = $state(false);
</script>

<div class="stg">
  <!-- Font size -->
  <div class="row">
    <div class="grow">终端字号<div class="desc">也支持在终端区双指缩放</div></div>
    <input type="range" min="10" max="18" value={settings.fontSize}
      oninput={(e) => update("fontSize", Number((e.target as HTMLInputElement).value))} />
    <span class="val">{settings.fontSize}</span>
  </div>

  <!-- Keyboard layout -->
  <div class="row">
    <div class="grow">键盘布局<div class="desc">全键盘 tab 采用笔记本布局，默认 Mac</div></div>
    <div class="seg">
      <button class:on={settings.layout === "mac"} onclick={() => update("layout", "mac")}>Mac</button>
      <button class:on={settings.layout === "win"} onclick={() => update("layout", "win")}>Win</button>
    </div>
  </div>

  <!-- Vibration -->
  <div class="row">
    <div class="grow">按键震动</div>
    <div class="tog" class:on={settings.vibrate} role="switch" aria-checked={settings.vibrate} tabindex="0"
      onclick={() => update("vibrate", !settings.vibrate)}
      onkeydown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); update("vibrate", !settings.vibrate); } }}></div>
  </div>

  <!-- Device management (nested from old floating UI) -->
  <div class="row" style="border:none">
    <div class="grow">设备管理<div class="desc">配对新设备、查看已登记设备、吊销</div></div>
    <button class="btn" onclick={() => (showDevices = !showDevices)}>
      {showDevices ? "关闭" : "管理 ›"}
    </button>
  </div>

  {#if showDevices}
    <DeviceManager {conn} onClose={() => (showDevices = false)} />
  {/if}
</div>

<style>
  .stg { padding: 8px; color: #ddd; }
  .row { display: flex; align-items: center; gap: 10px; padding: 12px 4px; border-bottom: 1px solid #222; font-size: 14px; }
  .grow { flex: 1; }
  .desc { font-size: 11px; color: #888; margin-top: 2px; }
  .val { font-size: 12px; color: #888; min-width: 2em; text-align: right; }
  input[type="range"] { width: 100px; accent-color: #2d4; }
  .seg { display: flex; border: 1px solid #333; border-radius: 6px; overflow: hidden; }
  .seg button { background: none; border: 0; color: #999; padding: 5px 11px; font-size: 12px; }
  .seg button.on { background: #2d4; color: #000; }
  .tog { width: 36px; height: 21px; border-radius: 11px; background: #333; position: relative; flex: 0 0 auto; border: 1px solid #444; }
  .tog::after { content: ""; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: #888; transition: .15s; }
  .tog.on { background: #2d4; border-color: #2d4; }
  .tog.on::after { left: 17px; background: #000; }
  .btn { background: #2d4; color: #000; border: 0; border-radius: 6px; padding: 5px 12px; font-size: 13px; }
</style>
