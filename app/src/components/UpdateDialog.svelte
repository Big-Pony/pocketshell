<script lang="ts">
  import { t } from "svelte-i18n";
  import { phaseLabelKey, type CheckResult } from "../lib/update";

  let { info, phase = null, pct = null, message = null, onConfirm, onCancel } = $props<{
    info: CheckResult;
    phase?: string | null;
    pct?: number | null;
    message?: string | null;
    onConfirm: () => void;
    onCancel: () => void;
  }>();

  const busy = $derived(phase !== null && phase !== "error");
</script>

<div class="backdrop" role="dialog" aria-modal="true" tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
  onkeydown={(e) => { if (e.key === "Escape" && !busy) onCancel(); }}>
  <div class="dlg">
    <div class="hd mono">{$t("update.title")}</div>
    <div class="vers mono">
      <span class="dim">{$t("update.current")}</span> {info.current}
      <span class="arr">→</span>
      <span class="dim">{$t("update.latest")}</span> {info.latest}
    </div>
    {#if info.notes}<pre class="notes">{info.notes}</pre>{/if}

    {#if phase === null}
      <div class="btns">
        <button onclick={onCancel}>{$t("update.cancel")}</button>
        <button class="primary" onclick={onConfirm}>{$t("update.confirm")}</button>
      </div>
    {:else if phase === "error"}
      <div class="phase err">{$t("update.phase.error")}{message ? `: ${message}` : ""}</div>
      <div class="btns">
        <button onclick={onCancel}>{$t("update.close")}</button>
        <button class="primary" onclick={onConfirm}>{$t("update.retry")}</button>
      </div>
    {:else}
      <div class="phase">{$t(phaseLabelKey(phase))}{typeof pct === "number" ? ` ${pct}%` : ""}</div>
      <div class="bar"><div class="fill" style="width:{typeof pct === 'number' ? pct : 30}%"></div></div>
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 50; background: var(--overlay-bg); display: grid; place-items: center; }
  .dlg {
    background: var(--dlg-bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    padding: 16px;
    width: min(88vw, 340px);
    color: var(--text);
    box-shadow: var(--pop-shadow);
  }
  .hd { font-weight: 600; margin-bottom: 10px; font-size: 0.85rem; }
  .vers { margin-bottom: 10px; font-size: 0.78rem; }
  .dim { color: var(--dim); }
  .arr { color: var(--accent); margin: 0 4px; }
  .notes {
    max-height: 30vh;
    overflow: auto;
    background: var(--term-bg);
    color: var(--term-text);
    padding: 8px;
    border-radius: var(--radius-md);
    font-size: 12px;
    white-space: pre-wrap;
  }
  .btns { display: flex; gap: 8px; margin-top: 14px; }
  .btns button {
    flex: 1;
    padding: 8px 0;
    border-radius: var(--radius-md);
    border: 1px solid var(--line);
    background: var(--key);
    color: var(--text);
    font-size: 0.73rem;
    cursor: pointer;
    font: inherit;
  }
  .btns button.primary { background: var(--primary-bg); color: var(--primary-text); border-color: transparent; }
  .phase { margin-top: 12px; color: var(--dim); font-size: 0.78rem; }
  .phase.err { color: var(--red); }
  .bar { height: 6px; background: var(--line); border-radius: var(--radius-sm); overflow: hidden; margin-top: 8px; }
  .fill { height: 100%; background: var(--accent); transition: width 0.2s; }
</style>
