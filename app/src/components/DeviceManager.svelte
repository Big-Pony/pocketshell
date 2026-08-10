<!-- app/src/components/DeviceManager.svelte -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import type { Connection } from "../lib/net/connection";
  import type { DeviceInfo } from "../lib/net/protocol";
  import { parsePairingString } from "../lib/net/pairing";
  import { applyPairing } from "../lib/net/keystore";
  import Skeleton from "./ui/Skeleton.svelte";

  let { conn, onClose, prefill = "" }: { conn: Connection; onClose: () => void; prefill?: string } = $props();

  // svelte-ignore state_referenced_locally
  let pasteText = $state(prefill);
  const fromClipboard = prefill !== "";
  let deviceName = $state("");
  let error = $state("");
  let devices = $state<DeviceInfo[]>([]);
  // 加载中 ≠ 空。共用一个条件会让用户先看到一句肯定的错话（14 期需求 5）。
  let loaded = $state(false);

  $effect(() => {
    const off = conn.onDevices((d) => { devices = d; loaded = true; });
    conn.listDevices();
    return off;
  });

  function submitPairing() {
    error = "";
    const r = parsePairingString(pasteText);
    if (!r.ok) { error = r.error; return; }
    if (!deviceName.trim()) { error = tr("devices.err.noName"); return; }
    applyPairing({ ...r.value, deviceName: deviceName.trim() });
    location.reload();
  }

  function revoke(d: DeviceInfo) {
    if (d.source === "env") return;
    const msg = d.self ? tr("devices.revokeSelf") : tr("devices.revokeOther", { name: d.name });
    if (!confirm(msg)) return;
    conn.revokeDevice(d.pubKey);
    conn.listDevices();
  }
</script>

<div class="dm-overlay" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }} onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}>
  <div class="dm-panel">
    <header>
      <h2>{$t('devices.title')}</h2>
      <button class="close" onclick={onClose} aria-label={$t('common.close')}>×</button>
    </header>

    <section class="dm-pair">
      <h3>{$t('devices.pairTitle')}</h3>
      <textarea bind:value={pasteText} placeholder={$t('devices.pairPh')} rows="3"></textarea>
      {#if fromClipboard}<p class="dm-hint">{$t('devices.fromClipboard')}</p>{/if}
      <input bind:value={deviceName} placeholder={$t('devices.namePh')} />
      <button class="pair-btn" onclick={submitPairing}>{$t('devices.pairBtn')}</button>
      {#if error}<p class="dm-error">{error}</p>{/if}
    </section>

    <section class="dm-list">
      <h3>{$t('devices.listTitle')}</h3>
      {#each devices as d (d.pubKey)}
        <div class="dm-row">
          <span class="dm-name">{d.name}{#if d.self} · {$t('devices.self')}{/if}</span>
          <span class="dm-src">{d.source}</span>
          <span class="dm-seen">{d.lastSeen ?? "—"}</span>
          <button disabled={d.source === "env"} onclick={() => revoke(d)}>{$t('devices.revoke')}</button>
        </div>
      {/each}
      {#if !loaded}
        <Skeleton rows={2} />
      {:else if devices.length === 0}
        <div class="dm-empty">{$t('devices.empty')}</div>
      {/if}
    </section>
  </div>
</div>

<style>
  .dm-hint { color: var(--ok); font-size: 0.68rem; margin: 2px 0 4px; }
  .dm-overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay-bg);
    display: grid;
    place-items: center;
    z-index: 50;
    padding: 16px;
  }
  .dm-panel {
    background: var(--dlg-bg);
    color: var(--text);
    width: min(92vw, 460px);
    max-height: 80vh;
    overflow: auto;
    border-radius: var(--radius-xl);
    padding: 16px;
    border: 1px solid var(--line);
    box-shadow: var(--pop-shadow);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
  }
  h2 { font-size: 0.95rem; font-weight: 700; }
  .close {
    background: transparent;
    border: 0;
    color: var(--dim);
    font-size: 1.3rem;
    line-height: 1;
    padding: 4px 8px;
  }

  section h3 {
    font-size: 0.72rem;
    color: var(--dim);
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .dm-pair {
    margin-bottom: 18px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--line);
  }
  .dm-pair textarea,
  .dm-pair input {
    width: 100%;
    margin: 6px 0;
    box-sizing: border-box;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 8px;
    font-family: inherit;
    font-size: 0.78rem;
    outline: none;
  }
  .dm-pair textarea { resize: none; }
  .dm-pair textarea:focus,
  .dm-pair input:focus { border-color: var(--accent); }
  .pair-btn {
    width: 100%;
    background: var(--primary-bg);
    color: var(--primary-text);
    border: 0;
    border-radius: var(--radius-md);
    padding: 9px;
    font-weight: 600;
    margin-top: 4px;
  }
  .dm-error { color: var(--red); font-size: 0.72rem; margin-top: 6px; }

  .dm-row {
    display: grid;
    grid-template-columns: 1fr auto auto auto;
    gap: 8px;
    align-items: center;
    padding: 8px 0;
    border-top: 1px solid var(--line);
    font-size: 13px;
  }
  .dm-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dm-src, .dm-seen { color: var(--dim); font-size: 0.68rem; }
  .dm-seen { font-variant-numeric: tabular-nums; }
  .dm-row button {
    background: var(--key);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 3px 8px;
    font-size: 0.68rem;
  }
  .dm-row button:not(:disabled):active { background: var(--red); color: var(--on-danger); border-color: var(--red); }
  .dm-row button:disabled { opacity: 0.4; }
  .dm-empty { color: var(--dim); font-size: 0.72rem; padding: 10px 0; text-align: center; }
</style>
