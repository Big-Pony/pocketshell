<!-- app/src/components/HintManager.svelte -->
<!-- 需求 5：用户自定义输入联想库的管理面板。内置的条目不在此展示、不可删。 -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import type { Connection } from "../lib/net/connection";
  import type { Hint } from "../lib/net/protocol";
  import { parseHintImport, filterAgainstBuiltins, buildHintPrompt, ALL_BUILTINS, HINT_MAX_LEN } from "../lib/hints";
  import { CATALOG } from "../lib/command-catalog";
  import { SLASH_CATALOG } from "../lib/slash-catalog";

  let { conn }: { conn: Connection } = $props();

  let items = $state<Hint[]>([]);
  let draft = $state("");
  let editing = $state<Hint | null>(null);
  let importText = $state("");
  let notice = $state("");

  async function reload() {
    try { items = (await conn.listHints()).items; } catch { /* 断线时保持现状 */ }
  }
  $effect(() => {
    const off = conn.onHintsChanged(() => void reload());
    void reload();
    return off;
  });

  // 服务端超限拒绝（hints_limit）走 error 广播而非 rpc 拒绝，不接就会静默失败——
  // 用户只看到「导入 0 条」却不知道为什么。
  $effect(() => conn.onError((e) => {
    if (e.code === "hints_limit") notice = tr("hints.limitHit");
  }));

  function submitDraft() {
    const text = draft.trim();
    if (!text) return;
    if (text.length > HINT_MAX_LEN) { notice = tr("hints.tooLong", { max: HINT_MAX_LEN }); return; }
    if (editing) conn.updateHint(editing.id, text);
    else conn.addHints([text]);
    draft = "";
    editing = null;
    notice = "";
  }
  function startEdit(h: Hint) { editing = h; draft = h.text; }
  function cancelEdit() { editing = null; draft = ""; }
  function del(h: Hint) { conn.removeHint(h.id); if (editing?.id === h.id) cancelEdit(); }

  function clearAll() {
    if (!confirm(tr("hints.clearConfirm"))) return;
    conn.clearHints();
    cancelEdit();
  }

  function copyPrompt() {
    navigator.clipboard?.writeText(buildHintPrompt(items.map((i) => i.text), [...CATALOG, ...SLASH_CATALOG]));
    notice = tr("hints.copied");
  }

  async function doImport() {
    const parsed = parseHintImport(importText);
    if (parsed.error) { notice = tr("hints.importFailed"); return; }
    const { ok, builtinHits } = filterAgainstBuiltins(parsed.ok, ALL_BUILTINS);
    const before = items.length;
    if (ok.length) {
      conn.addHints(ok);
      await reload();   // hintsChanged 也会触发，这里主动拉一次好立即算出新增数
    }
    const added = Math.max(0, items.length - before);
    const skipExisting = ok.length - added;

    const parts: string[] = [];
    if (builtinHits) parts.push(tr("hints.skipBuiltin", { n: builtinHits }));
    if (skipExisting) parts.push(tr("hints.skipExisting", { n: skipExisting }));
    if (parsed.skippedDup) parts.push(tr("hints.skipDup", { n: parsed.skippedDup }));
    if (parsed.skippedLong) parts.push(tr("hints.skipLong", { n: parsed.skippedLong }));

    const skippedTotal = builtinHits + skipExisting + parsed.skippedDup + parsed.skippedLong;
    notice = tr("hints.importResult", { added })
      + (skippedTotal ? tr("hints.importSkipped", { total: skippedTotal, detail: parts.join("、") }) : "");
    importText = "";
  }
</script>

<!-- 说明文案由设置面板的入口行常驻显示（hints.desc），这里不再重复一遍 -->
<div class="hm">
  {#if notice}<div class="hm-notice">{notice}</div>{/if}

  <div class="hm-list">
    {#if items.length === 0}
      <div class="hm-empty">{$t('hints.empty')}</div>
    {/if}
    {#each items as h (h.id)}
      <div class="hm-row" class:on={editing?.id === h.id}>
        <span class="hm-text mono">{h.text}</span>
        <button class="hm-act" aria-label={$t('hints.edit')} onclick={() => startEdit(h)}>✎</button>
        <button class="hm-act danger" aria-label={$t('hints.delete')} onclick={() => del(h)}>×</button>
      </div>
    {/each}
  </div>

  <div class="hm-add">
    <input class="hm-input" bind:value={draft} placeholder={$t('hints.addPh')} maxlength={HINT_MAX_LEN}
      onkeydown={(e) => { if (e.key === 'Enter') submitDraft(); }} />
    <button class="hm-primary" onclick={submitDraft}>{editing ? $t('hints.saveEdit') : $t('hints.add')}</button>
    {#if editing}<button class="hm-btn" onclick={cancelEdit}>{$t('hints.cancelEdit')}</button>{/if}
  </div>

  <textarea class="hm-ta" bind:value={importText} rows="3" placeholder={$t('hints.importPh')}></textarea>
  <div class="hm-ops">
    <button class="hm-btn" onclick={doImport}>{$t('hints.import')}</button>
    <button class="hm-btn" onclick={copyPrompt}>{$t('hints.copyPrompt')}</button>
    <button class="hm-btn danger" onclick={clearAll}>{$t('hints.clearAll')}</button>
  </div>
</div>

<style>
  /* 只引用 app.css 的语义令牌，不写死颜色——6 套主题共用 */
  .hm { display: flex; flex-direction: column; gap: 8px; padding: 4px 0 8px; }
  .hm-notice {
    font-size: 0.68rem; color: var(--accent-text);
    background: var(--accent-soft); border-radius: var(--radius-sm); padding: 6px 8px;
  }
  .hm-list { display: flex; flex-direction: column; gap: 4px; max-height: 40vh; overflow-y: auto; }
  .hm-empty { font-size: 0.7rem; color: var(--dim); text-align: center; padding: 16px 8px; line-height: 1.6; }
  .hm-row {
    display: flex; align-items: center; gap: 4px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 4px 4px 4px 8px;
  }
  .hm-row.on { border-color: var(--accent); }
  .hm-text {
    flex: 1; min-width: 0; font-size: 0.72rem; color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .mono { font-family: "JetBrains Mono", "SF Mono", ui-monospace, monospace; }
  .hm-act {
    flex: 0 0 auto; background: transparent; color: var(--dim);
    border: 0; padding: 4px 7px; font-size: 0.8rem;
  }
  .hm-act.danger { color: var(--red); }
  .hm-act:active { background: var(--keyhi); border-radius: 3px; }
  .hm-add { display: flex; gap: 6px; }
  .hm-input {
    flex: 1; min-width: 0; box-sizing: border-box;
    background: var(--panel2); border: 1px solid var(--line-strong); border-radius: var(--radius-md);
    color: var(--text); padding: 8px 10px; font-size: 0.76rem; outline: none;
  }
  .hm-input:focus { border-color: var(--accent); }
  .hm-ta {
    width: 100%; box-sizing: border-box; resize: none; font-family: inherit;
    background: var(--panel2); border: 1px solid var(--line-strong); border-radius: var(--radius-md);
    color: var(--text); padding: 8px 10px; font-size: 0.76rem; outline: none;
  }
  .hm-ta:focus { border-color: var(--accent); }
  .hm-ops { display: flex; gap: 6px; }
  .hm-btn {
    flex: 1; background: var(--key); color: var(--text);
    border: 1px solid var(--key-line); border-radius: var(--radius-md);
    padding: 8px 0; font-size: 0.72rem;
  }
  .hm-btn:active { background: var(--keyhi); }
  /* 危险态底色换 --panel：--red 铺在更亮的 --key 上，石墨橙下对比度只有 4.12
     （低于 WCAG AA 4.5）；--panel 在 6 套主题下均 ≥4.56。实测见测试报告。 */
  .hm-btn.danger { color: var(--red); background: var(--panel); }
  .hm-primary {
    flex: 0 0 auto; background: var(--primary-bg); color: var(--primary-text);
    border: 1px solid transparent; border-radius: var(--radius-md);
    padding: 8px 14px; font-size: 0.72rem; font-weight: 600;
  }
</style>
