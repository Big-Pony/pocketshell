<!-- app/src/components/DeviceManager.svelte -->
<script lang="ts">
  import type { Connection } from "../lib/connection";
  import type { DeviceInfo } from "../lib/protocol";
  import { parsePairingString } from "../lib/pairing";
  import { applyPairing } from "../lib/keystore";

  let { conn, onClose }: { conn: Connection; onClose: () => void } = $props();

  let pasteText = $state("");
  let deviceName = $state("");
  let error = $state("");
  let devices = $state<DeviceInfo[]>([]);

  $effect(() => {
    const off = conn.onDevices((d) => (devices = d));
    conn.listDevices();
    return off;
  });

  function submitPairing() {
    error = "";
    const r = parsePairingString(pasteText);
    if (!r.ok) { error = r.error; return; }
    if (!deviceName.trim()) { error = "请填写本设备名称"; return; }
    applyPairing({ ...r.value, deviceName: deviceName.trim() });
    location.reload();
  }

  function revoke(d: DeviceInfo) {
    if (d.source === "env") return;
    const msg = d.self ? "吊销后本机将断开且需重新配对，确定？" : `吊销设备「${d.name}」？`;
    if (!confirm(msg)) return;
    conn.revokeDevice(d.pubKey);
    conn.listDevices();
  }
</script>

<div class="dm-overlay" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }} onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}>
  <div class="dm-panel">
    <header>
      <h2>设备管理</h2>
      <button class="close" onclick={onClose} aria-label="关闭">×</button>
    </header>

    <section class="dm-pair">
      <h3>配对新设备（本机）</h3>
      <textarea bind:value={pasteText} placeholder="粘贴 pocketshell-pair:… 配对串" rows="3"></textarea>
      <input bind:value={deviceName} placeholder="本设备名称，如 iPhone" />
      <button class="pair-btn" onclick={submitPairing}>配对并连接</button>
      {#if error}<p class="dm-error">{error}</p>{/if}
    </section>

    <section class="dm-list">
      <h3>已登记设备</h3>
      {#each devices as d (d.pubKey)}
        <div class="dm-row">
          <span class="dm-name">{d.name}{#if d.self} · 本机{/if}</span>
          <span class="dm-src">{d.source}</span>
          <span class="dm-seen">{d.lastSeen ?? "—"}</span>
          <button disabled={d.source === "env"} onclick={() => revoke(d)}>吊销</button>
        </div>
      {/each}
      {#if devices.length === 0}
        <div class="dm-empty">暂无已登记设备</div>
      {/if}
    </section>
  </div>
</div>

<style>
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
  .dm-row button:not(:disabled):active { background: var(--red); color: #fff; border-color: var(--red); }
  .dm-row button:disabled { opacity: 0.4; }
  .dm-empty { color: var(--dim); font-size: 0.72rem; padding: 10px 0; text-align: center; }
</style>
