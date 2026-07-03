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

<div class="dm-overlay" role="dialog" aria-modal="true">
  <div class="dm-panel">
    <header><h2>设备管理</h2><button onclick={onClose} aria-label="关闭">×</button></header>

    <section class="dm-pair">
      <h3>配对新设备（本机）</h3>
      <textarea bind:value={pasteText} placeholder="粘贴 pocketshell-pair:… 配对串" rows="3"></textarea>
      <input bind:value={deviceName} placeholder="本设备名称，如 iPhone" />
      <button onclick={submitPairing}>配对并连接</button>
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
    </section>
  </div>
</div>

<style>
  .dm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: grid; place-items: center; z-index: 50; }
  .dm-panel { background: #1e1e1e; color: #eee; width: min(92vw, 460px); max-height: 80vh; overflow: auto; border-radius: 10px; padding: 16px; }
  .dm-panel header { display: flex; justify-content: space-between; align-items: center; }
  .dm-pair textarea, .dm-pair input { width: 100%; margin: 6px 0; box-sizing: border-box; }
  .dm-error { color: #ff6b6b; }
  .dm-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 8px; align-items: center; padding: 6px 0; border-top: 1px solid #333; font-size: 13px; }
  .dm-src { opacity: .6; }
  .dm-seen { opacity: .6; font-variant-numeric: tabular-nums; }
</style>
