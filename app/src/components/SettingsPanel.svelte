<!-- app/src/components/SettingsPanel.svelte -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { Connection } from "../lib/connection";
  import type { Settings } from "../lib/settings";
  import DeviceManager from "./DeviceManager.svelte";

  let { conn, settings, onChange, currentVersion, onCheckUpdate }: {
    conn: Connection; settings: Settings; onChange: (s: Settings) => void;
    currentVersion: string; onCheckUpdate: () => Promise<void>;
  } = $props();

  function update<K extends keyof Settings>(k: K, v: Settings[K]) {
    onChange({ ...settings, [k]: v });
  }

  let showDevices = $state(false);
  let checkingUpdate = $state(false);
  async function checkNow() {
    checkingUpdate = true;
    try { await onCheckUpdate(); } finally { checkingUpdate = false; }
  }
</script>

<div class="stg">
  <!-- Theme -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.theme.label')}</div>
      <div class="desc">{$t('settings.theme.desc')}</div>
    </div>
    <div class="seg">
      <button class:on={settings.theme === "dark"} onclick={() => update("theme", "dark")}>{$t('settings.theme.dark')}</button>
      <button class:on={settings.theme === "light"} onclick={() => update("theme", "light")}>{$t('settings.theme.light')}</button>
      <button class:on={settings.theme === "system"} onclick={() => update("theme", "system")}>{$t('settings.theme.system')}</button>
    </div>
  </div>

  <!-- Language -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.language.label')}</div>
      <div class="desc">{$t('settings.language.desc')}</div>
    </div>
    <div class="seg">
      <button class:on={settings.language === "zh"} onclick={() => update("language", "zh")}>中文</button>
      <button class:on={settings.language === "en"} onclick={() => update("language", "en")}>English</button>
    </div>
  </div>

  <!-- Font size -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.fontSize.label')}</div>
      <div class="desc">{$t('settings.fontSize.desc')}</div>
    </div>
    <input type="range" min="10" max="18" step="0.5" value={settings.fontSize}
      oninput={(e) => update("fontSize", Number((e.target as HTMLInputElement).value))} />
    <span class="val">{settings.fontSize}</span>
  </div>

  <!-- Keyboard layout -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.layout.label')}</div>
      <div class="desc">{$t('settings.layout.desc')}</div>
    </div>
    <div class="seg">
      <button class:on={settings.layout === "mac"} onclick={() => update("layout", "mac")}>Mac</button>
      <button class:on={settings.layout === "win"} onclick={() => update("layout", "win")}>Win</button>
    </div>
  </div>

  <!-- Vibration -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.vibrate.label')}</div>
      <div class="desc">{$t('settings.vibrate.desc')}</div>
    </div>
    <div class="seg">
      <button class:on={settings.vibrate === "off"} onclick={() => update("vibrate", "off")}>{$t('settings.vibrate.off')}</button>
      <button class:on={settings.vibrate === "light"} onclick={() => update("vibrate", "light")}>{$t('settings.vibrate.light')}</button>
      <button class:on={settings.vibrate === "medium"} onclick={() => update("vibrate", "medium")}>{$t('settings.vibrate.medium')}</button>
      <button class:on={settings.vibrate === "strong"} onclick={() => update("vibrate", "strong")}>{$t('settings.vibrate.strong')}</button>
    </div>
  </div>

  <!-- Device management -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.devices.label')}</div>
      <div class="desc">{$t('settings.devices.desc')}</div>
    </div>
    <button class="btn" onclick={() => (showDevices = !showDevices)}>
      {showDevices ? $t('settings.devices.close') : $t('settings.devices.manage')}
    </button>
  </div>

  <!-- Update check -->
  <div class="set" style="border:none">
    <div class="grow">
      <div class="label">{$t('update.checkNow')}</div>
      <div class="desc">v{currentVersion}</div>
    </div>
    <button class="btn" disabled={checkingUpdate} onclick={checkNow}>
      {checkingUpdate ? $t('update.checking') : $t('update.checkNow')}
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
  .btn {
    background: var(--primary-bg);
    color: var(--primary-text);
    border: 0;
    border-radius: 999px;
    padding: 7px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .btn:disabled { opacity: 0.5; cursor: default; }
</style>
