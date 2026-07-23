<!-- app/src/components/SnippetPanel.svelte -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import type { Connection } from "../lib/connection";
  import type { Snippet } from "../lib/protocol";
  import { mergeSnippets } from "../lib/snippets";

  let { conn, onInsert }: { conn: Connection; onInsert: (text: string) => void } = $props();

  let customs = $state<Snippet[]>([]);
  let adding = $state(false);
  let form = $state({ group: "", label: "", command: "", autoEnter: true });

  $effect(() => {
    const off = conn.onSnippets((s) => (customs = s));
    conn.listSnippets();
    return off;
  });

  const groups = $derived(mergeSnippets(customs));

  function insert(s: Snippet) { onInsert(s.command + (s.autoEnter ? "\r" : "")); }
  function isCustom(s: Snippet) { return !s.id.startsWith("builtin:"); }
  function submit() {
    if (!form.label.trim() || !form.command.trim()) return;
    conn.addSnippet({ group: form.group.trim() || tr("snippets.defaultGroup"), label: form.label.trim(), command: form.command, autoEnter: form.autoEnter });
    form = { group: form.group, label: "", command: "", autoEnter: true };
    adding = false;
  }
  function del(s: Snippet) {
    if (!confirm(tr("snippets.delConfirm", { label: s.label }))) return;
    conn.removeSnippet(s.id);
  }
  function autoFocus(node: HTMLElement) { node.focus(); }
</script>

<div class="sp">
  <div class="sp-head">
    <span class="title">{$t('snippets.title')}</span>
    <button class="add-btn" onclick={() => (adding = true)}>{$t('snippets.add')}</button>
  </div>

  <div class="groups">
    {#if groups.length === 0}
      <div class="sp-empty">{$t('snippets.empty')}</div>
    {/if}
    {#each groups as g (g.group)}
      <div class="sp-group">{g.group}</div>
      <div class="sp-items">
        {#each g.items as s (s.id)}
          <div class="sp-row">
            <button class="ins" onclick={() => insert(s)} title={s.command}>
              {s.label}{#if s.autoEnter}<span class="cr">⏎</span>{/if}
            </button>
            {#if isCustom(s)}<button class="del" onclick={() => del(s)} aria-label={$t('common.delete')}>×</button>{/if}
          </div>
        {/each}
      </div>
    {/each}
    <div class="hint">{$t('snippets.hint')}</div>
  </div>
</div>

{#if adding}
  <div class="overlay" role="presentation" onclick={() => (adding = false)}>
    <div class="dlg" role="dialog" aria-modal="true" aria-label={$t('snippets.add')} tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === 'Escape') adding = false; }}>
      <div class="dlg-title">{$t('snippets.add')}</div>
      <input class="dlg-input" use:autoFocus bind:value={form.group} placeholder={$t('snippets.groupPh')} />
      <input class="dlg-input" bind:value={form.label} placeholder={$t('snippets.labelPh')} />
      <input class="dlg-input" bind:value={form.command} placeholder={$t('snippets.cmdPh')}
        onkeydown={(e) => { if (e.key === 'Enter') submit(); }} />
      <label class="check"><input type="checkbox" bind:checked={form.autoEnter} /> {$t('snippets.autoEnter')}</label>
      <div class="dlg-btns">
        <button onclick={() => (adding = false)}>{$t('snippets.cancel')}</button>
        <button class="primary" onclick={submit}>{$t('snippets.save')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sp {
    padding: 10px 12px;
    color: var(--text);
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .sp-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    flex: 0 0 auto;
  }
  .title { font-size: 0.9rem; font-weight: 700; }
  .add-btn {
    background: var(--accent-soft);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: 999px;
    padding: 6px 13px;
    font-size: 0.72rem;
    font-weight: 600;
  }
  .check {
    font-size: 0.72rem;
    color: var(--dim);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .groups { flex: 1; overflow-y: auto; }
  .sp-empty {
    color: var(--dim);
    font-size: 0.72rem;
    text-align: center;
    padding: 20px 8px;
  }
  .sp-group {
    color: var(--dimmer);
    font-size: 0.62rem;
    font-weight: 700;
    margin: 10px 2px 6px;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  .sp-items {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }
  .sp-row {
    display: flex;
    align-items: center;
    background: var(--panel);
    border: 1px solid var(--line-soft);
    border-radius: 999px;
    overflow: hidden;
  }
  .ins {
    background: transparent;
    color: var(--text);
    border: 0;
    padding: 7px 11px;
    font-size: 0.75rem;
    font-family: "SF Mono", ui-monospace, monospace;
  }
  .ins:active { background: var(--keyhi); }
  .cr { color: var(--accent); margin-left: 5px; font-size: 0.65rem; }
  .del {
    background: transparent;
    color: var(--red);
    border: 0;
    border-left: 1px solid var(--line);
    padding: 7px 9px;
    font-size: 0.9rem;
  }
  .del:active { background: rgba(224, 108, 95, 0.15); }

  .hint {
    font-size: 0.68rem;
    color: var(--dim);
    line-height: 1.6;
    margin-top: 16px;
    padding-bottom: 8px;
  }

  .overlay { position: fixed; inset: 0; z-index: 40; background: var(--overlay-bg); display: flex; justify-content: center; align-items: flex-start; }
  .overlay .dlg { margin-top: 14vh; }
  .dlg { background: var(--dlg-bg); border: 1px solid var(--line); border-radius: var(--radius-xl); padding: 20px; width: min(300px, 84vw); box-shadow: var(--pop-shadow); }
  .dlg-title { font-size: 0.85rem; font-weight: 700; margin-bottom: 12px; text-align: center; }
  .dlg-input { width: 100%; box-sizing: border-box; background: var(--panel2); border: 1px solid var(--line-strong); border-radius: var(--radius-md); color: var(--text); padding: 8px 10px; font-size: 0.8rem; margin-bottom: 10px; outline: none; }
  .dlg-input:focus { border-color: var(--accent); }
  .dlg-btns { display: flex; gap: 8px; margin-top: 6px; }
  .dlg-btns button { flex: 1; padding: 9px 0; border-radius: var(--radius-md); border: 1px solid var(--line); font-size: 0.75rem; background: var(--key); color: var(--text); }
  .dlg-btns button.primary { background: var(--primary-bg); color: var(--primary-text); border-color: transparent; font-weight: 600; }
</style>
