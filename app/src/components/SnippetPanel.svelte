<!-- app/src/components/SnippetPanel.svelte -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import type { Connection } from "../lib/net/connection";
  import type { Snippet } from "../lib/net/protocol";
  import { mergeSnippets } from "../lib/snippets";
  import Skeleton from "./ui/Skeleton.svelte";

  let { conn, onInsert }: { conn: Connection; onInsert: (text: string) => void } = $props();

  let customs = $state<Snippet[]>([]);
  // 加载中 ≠ 空（14 期需求 5）：listSnippets 是 push 型，回调到达前
  // groups 恒为空，与「真的没有片段」共用条件就会先给出一句错话。
  let loaded = $state(false);
  let mode = $state<"use" | "manage">("use");
  let adding = $state(false);
  let editing = $state<Snippet | null>(null);
  const dlgOpen = $derived(adding || editing !== null);
  let form = $state({ group: "", label: "", command: "", autoEnter: true });

  function closeDlg() { adding = false; editing = null; }
  function openAdd() { editing = null; form = { group: form.group, label: "", command: "", autoEnter: true }; adding = true; }
  function openEdit(s: Snippet) {
    adding = false;
    form = { group: s.group, label: s.label, command: s.command, autoEnter: s.autoEnter };
    editing = s;
  }
  // 管理是临时态，不跨面板切换保留（底栏面板 keep-alive 会留住组件实例）
  function exitManage() { mode = "use"; closeDlg(); }
  function tapSnippet(s: Snippet) { if (mode === "manage") openEdit(s); else insert(s); }

  $effect(() => {
    const off = conn.onSnippets((s) => { customs = s; loaded = true; });
    conn.listSnippets();
    return off;
  });

  const groups = $derived(mergeSnippets(customs));

  function insert(s: Snippet) { onInsert(s.command + (s.autoEnter ? "\r" : "")); }
  function submit() {
    if (!form.label.trim() || !form.command.trim()) return;
    const payload = {
      group: form.group.trim() || tr("snippets.defaultGroup"),
      label: form.label.trim(),
      command: form.command,
      autoEnter: form.autoEnter,
    };
    if (editing) conn.updateSnippet(editing.id, payload);
    else conn.addSnippet(payload);
    form = { group: form.group, label: "", command: "", autoEnter: true };
    closeDlg();
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
    {#if mode === "manage"}
      <button class="add-btn" onclick={exitManage}>{$t('snippets.done')}</button>
    {:else}
      <div class="head-btns">
        <button class="manage-btn" onclick={() => (mode = "manage")}>{$t('snippets.manage')}</button>
        <button class="add-btn" onclick={openAdd}>{$t('snippets.add')}</button>
      </div>
    {/if}
  </div>

  <div class="groups">
    {#if mode === "manage"}<div class="manage-hint">{$t('snippets.manageHint')}</div>{/if}
    {#if !loaded}
      <Skeleton rows={3} />
    {:else if groups.length === 0}
      <div class="sp-empty">{$t('snippets.empty')}</div>
    {/if}
    {#each groups as g (g.group)}
      <div class="sp-group">{g.group}</div>
      <div class="sp-items">
        {#each g.items as s (s.id)}
          <div class="sp-row">
            <button class="ins" onclick={() => tapSnippet(s)} title={s.command}>
              {s.label}{#if s.autoEnter}<span class="cr">⏎</span>{/if}
            </button>
            {#if mode === "manage"}<button class="del" onclick={() => del(s)} aria-label={$t('common.delete')}>×</button>{/if}
          </div>
        {/each}
      </div>
    {/each}
    <div class="hint">{$t('snippets.hint')}</div>
  </div>
</div>

{#if dlgOpen}
  <div class="overlay" role="presentation" onclick={closeDlg}>
    <div class="dlg" role="dialog" aria-modal="true" aria-label={editing ? $t('snippets.edit') : $t('snippets.add')} tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === 'Escape') closeDlg(); }}>
      <div class="dlg-title">{editing ? $t('snippets.edit') : $t('snippets.add')}</div>
      <input class="dlg-input" use:autoFocus bind:value={form.group} placeholder={$t('snippets.groupPh')} />
      <input class="dlg-input" bind:value={form.label} placeholder={$t('snippets.labelPh')} />
      <input class="dlg-input" bind:value={form.command} placeholder={$t('snippets.cmdPh')}
        onkeydown={(e) => { if (e.key === 'Enter') submit(); }} />
      <label class="check"><input type="checkbox" bind:checked={form.autoEnter} /> {$t('snippets.autoEnter')}</label>
      <div class="dlg-btns">
        <button onclick={closeDlg}>{$t('snippets.cancel')}</button>
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
  .title { font-size: 0.82rem; font-weight: 700; }
  .add-btn {
    background: var(--primary-bg);
    color: var(--primary-text);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    font-size: 0.72rem;
    font-weight: 600;
  }
  .head-btns { display: flex; gap: 6px; align-items: center; }
  .manage-btn {
    background: var(--key);
    color: var(--text);
    border: 1px solid var(--key-line);
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    font-size: 0.72rem;
  }
  .manage-btn:active { background: var(--keyhi); }
  .manage-hint {
    font-size: 0.68rem;
    color: var(--dim);
    padding: 6px 2px 2px;
  }
  .check {
    font-size: 0.72rem;
    color: var(--dim);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* 勾选框默认走浏览器蓝，与石墨橙不搭；对齐指令卡上的 ⏎ 标记（同为 --accent） */
  .check input[type="checkbox"] { accent-color: var(--accent); }

  .groups { flex: 1; overflow-y: auto; }
  .sp-empty {
    color: var(--dim);
    font-size: 0.72rem;
    text-align: center;
    padding: 20px 8px;
  }
  /* 分组标题走共同设计语言：mono 大写小标题 */
  .sp-group {
    color: var(--dimmer);
    font-family: var(--font-mono);
    font-size: 0.6rem;
    font-weight: 600;
    margin: 12px 2px 6px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .sp-items {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  /* 胶囊 → 方角小卡（4px），与整体仪表感一致 */
  .sp-row {
    display: flex;
    align-items: center;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 4px;
    overflow: hidden;
  }
  .ins {
    background: transparent;
    color: var(--text);
    border: 0;
    padding: 6px 10px;
    font-size: 0.72rem;
    font-family: var(--font-mono);
  }
  .ins:active { background: var(--keyhi); }
  .cr { color: var(--accent); margin-left: 5px; font-size: 0.6rem; }
  .del {
    background: transparent;
    color: var(--red);
    border: 0;
    border-left: 1px solid var(--line);
    padding: 6px 8px;
    font-size: 0.85rem;
  }
  .del:active { background: var(--red-soft); }

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
