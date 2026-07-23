<!-- app/src/components/OperationGuide.svelte -->
<script lang="ts">
  import { t } from "svelte-i18n";
  let { onClose }: { onClose: () => void } = $props();
  const SECTIONS = ["intro", "tabs", "icons", "gestures", "notify", "keyboard"] as const;
</script>

<div class="og-overlay" role="dialog" aria-modal="true" tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
  onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}>
  <div class="og-panel">
    <header>
      <h2>{$t('guide.title')}</h2>
      <button class="close" onclick={onClose} aria-label={$t('common.close')}>×</button>
    </header>
    <div class="og-scroll">
      {#each SECTIONS as s (s)}
        <section>
          <h3>{$t('guide.sections.' + s + '.h')}</h3>
          <p class="g-body">{$t('guide.sections.' + s + '.p')}</p>
        </section>
      {/each}
    </div>
  </div>
</div>

<style>
  .og-overlay { position: fixed; inset: 0; z-index: 50; background: var(--overlay-bg); display: flex; justify-content: center; align-items: flex-start; }
  .og-panel { background: var(--dlg-bg); border: 1px solid var(--line); border-radius: var(--radius-xl); margin-top: 8vh; width: min(440px, 92vw); max-height: 84vh; display: flex; flex-direction: column; box-shadow: var(--pop-shadow); }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  header h2 { font-size: 0.95rem; font-weight: 700; margin: 0; color: var(--text); }
  .close { background: transparent; border: 0; color: var(--dim); font-size: 1.3rem; line-height: 1; }
  .og-scroll { overflow-y: auto; padding: 12px 16px 18px; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
  section { margin-bottom: 16px; }
  h3 { font-size: 0.82rem; font-weight: 700; color: var(--accent); margin: 0 0 6px; }
  .g-body { font-size: 0.76rem; line-height: 1.7; color: var(--dim); white-space: pre-line; margin: 0; }
</style>
