<!-- app/src/components/SettingsPanel.svelte -->
<script lang="ts">
  import type { Connection } from "../lib/connection";
  import type { Settings } from "../lib/settings";
  import DeviceManager from "./DeviceManager.svelte";

  let { conn, settings, onChange }: {
    conn: Connection; settings: Settings; onChange: (s: Settings) => void;
  } = $props();

  function update<K extends keyof Settings>(k: K, v: Settings[K]) {
    onChange({ ...settings, [k]: v });
  }

  let showDevices = $state(false);
</script>

<div class="stg">
  <!-- Theme -->
  <div class="set">
    <div class="grow">
      <div class="label">界面风格</div>
      <div class="desc">深色 IDE / 浅色极简，或跟随系统外观</div>
    </div>
    <div class="seg">
      <button class:on={settings.theme === "dark"} onclick={() => update("theme", "dark")}>深色</button>
      <button class:on={settings.theme === "light"} onclick={() => update("theme", "light")}>浅色</button>
      <button class:on={settings.theme === "system"} onclick={() => update("theme", "system")}>跟随</button>
    </div>
  </div>

  <!-- Font size -->
  <div class="set">
    <div class="grow">
      <div class="label">终端字号</div>
      <div class="desc">也支持在终端区双指缩放</div>
    </div>
    <input type="range" min="10" max="18" step="0.5" value={settings.fontSize}
      oninput={(e) => update("fontSize", Number((e.target as HTMLInputElement).value))} />
    <span class="val">{settings.fontSize}</span>
  </div>

  <!-- Keyboard layout -->
  <div class="set">
    <div class="grow">
      <div class="label">键盘布局</div>
      <div class="desc">全键盘 tab 采用笔记本布局，默认 Mac</div>
    </div>
    <div class="seg">
      <button class:on={settings.layout === "mac"} onclick={() => update("layout", "mac")}>Mac</button>
      <button class:on={settings.layout === "win"} onclick={() => update("layout", "win")}>Win</button>
    </div>
  </div>

  <!-- Vibration -->
  <div class="set">
    <div class="grow">
      <div class="label">按键震动</div>
      <div class="desc">自定义键盘按下时短振一下</div>
    </div>
    <div class="tog" class:on={settings.vibrate} role="switch" aria-checked={settings.vibrate} tabindex="0"
      onclick={() => update("vibrate", !settings.vibrate)}
      onkeydown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); update("vibrate", !settings.vibrate); } }}></div>
  </div>

  <!-- Device management -->
  <div class="set" style="border:none">
    <div class="grow">
      <div class="label">设备管理</div>
      <div class="desc">配对新设备、查看已登记设备、吊销</div>
    </div>
    <button class="btn" onclick={() => (showDevices = !showDevices)}>
      {showDevices ? "关闭" : "管理 ›"}
    </button>
  </div>
</div>

{#if showDevices}
  <DeviceManager {conn} onClose={() => (showDevices = false)} />
{/if}

<style>
  .stg { padding: 8px; color: var(--text); }
  .set {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 4px;
    border-bottom: 1px solid var(--line);
    font-size: 14px;
  }
  .grow { flex: 1; }
  .label { font-size: 14px; }
  .desc { font-size: 11px; color: var(--dim); margin-top: 3px; }
  .val { font-size: 12px; color: var(--dim); min-width: 2.5em; text-align: right; }
  input[type="range"] { width: 110px; accent-color: var(--primary-bg); }
  .seg {
    display: flex;
    gap: 2px;
    background: var(--seg-bg);
    border: 1px solid var(--seg-line);
    border-radius: 999px;
    padding: 2px;
  }
  .seg button {
    background: transparent;
    border: 0;
    color: var(--dim);
    padding: 5px 12px;
    font-size: 12px;
    border-radius: 999px;
  }
  .seg button.on {
    background: var(--seg-active-bg);
    color: var(--seg-active-text);
    font-weight: 600;
    box-shadow: var(--seg-shadow);
  }
  .tog {
    width: 44px;
    height: 26px;
    border-radius: 999px;
    background: var(--keyhi);
    position: relative;
    flex: 0 0 auto;
    border: 1px solid var(--line);
    transition: background 0.15s;
  }
  .tog::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    transition: 0.15s;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
  .tog.on { background: var(--primary-bg); border-color: var(--primary-bg); }
  .tog.on::after { left: 20px; background: var(--primary-text); }
  .btn {
    background: var(--primary-bg);
    color: var(--primary-text);
    border: 0;
    border-radius: 999px;
    padding: 7px 14px;
    font-size: 13px;
    font-weight: 600;
  }
</style>
