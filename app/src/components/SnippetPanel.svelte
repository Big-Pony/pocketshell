<!-- app/src/components/SnippetPanel.svelte -->
<script lang="ts">
  import type { Connection } from "../lib/connection";
  import type { Snippet } from "../lib/protocol";
  import { mergeSnippets } from "../lib/snippets";

  let { conn, onInsert }: { conn: Connection; onInsert: (text: string) => void } = $props();

  let customs = $state<Snippet[]>([]);
  let adding = $state(false);
  let form = $state({ group: "项目", label: "", command: "", autoEnter: true });

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
    conn.addSnippet({ group: form.group.trim() || "项目", label: form.label.trim(), command: form.command, autoEnter: form.autoEnter });
    form = { group: form.group, label: "", command: "", autoEnter: true };
    adding = false;
  }
  function del(s: Snippet) {
    if (!confirm(`删除指令「${s.label}」？`)) return;
    conn.removeSnippet(s.id);
  }
</script>

<div class="sp">
  <div class="sp-head">
    <span class="title">⚡ 快捷指令</span>
    <button class="add-btn" onclick={() => (adding = !adding)}>{adding ? "取消" : "＋ 自定义"}</button>
  </div>

  {#if adding}
    <div class="sp-form">
      <input bind:value={form.group} placeholder="分组，如 项目" />
      <input bind:value={form.label} placeholder="显示名，如 build" />
      <input bind:value={form.command} placeholder="命令，如 npm run build" />
      <label class="check"><input type="checkbox" bind:checked={form.autoEnter} /> 自动回车 ⏎</label>
      <button class="save" onclick={submit}>保存</button>
    </div>
  {/if}

  <div class="groups">
    {#if groups.length === 0}
      <div class="sp-empty">还没有自定义指令，点右上角 ＋ 添加</div>
    {/if}
    {#each groups as g (g.group)}
      <div class="sp-group">{g.group}</div>
      <div class="sp-items">
        {#each g.items as s (s.id)}
          <div class="sp-row">
            <button class="ins" onclick={() => insert(s)} title={s.command}>
              {s.label}{#if s.autoEnter}<span class="cr">⏎</span>{/if}
            </button>
            {#if isCustom(s)}<button class="del" onclick={() => del(s)} aria-label="删除">×</button>{/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>

  <div class="hint">自定义指令会同步到同一 Agent 下的所有设备。</div>
</div>

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
  .title { font-size: 0.85rem; font-weight: 600; }
  .add-btn {
    background: var(--teal);
    color: var(--teal-dark);
    border: 0;
    border-radius: var(--radius-md);
    padding: 5px 11px;
    font-size: 0.72rem;
    font-weight: 600;
  }
  .sp-form {
    display: flex;
    flex-direction: column;
    gap: 7px;
    background: var(--panel2);
    padding: 10px;
    border-radius: var(--radius-lg);
    margin-bottom: 10px;
    border: 1px solid var(--line);
    flex: 0 0 auto;
  }
  .sp-form input {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 7px;
    font-size: 0.78rem;
    outline: none;
  }
  .sp-form input:focus { border-color: var(--teal); }
  .check {
    font-size: 0.72rem;
    color: var(--dim);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .save {
    background: var(--teal);
    color: var(--teal-dark);
    border: 0;
    border-radius: var(--radius-md);
    padding: 7px;
    font-weight: 600;
  }

  .groups { flex: 1; overflow-y: auto; }
  .sp-empty {
    color: var(--dim);
    font-size: 0.72rem;
    text-align: center;
    padding: 20px 8px;
  }
  .sp-group {
    color: var(--dim);
    font-size: 0.66rem;
    margin: 10px 2px 6px;
    letter-spacing: 0.5px;
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
    background: var(--panel2);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
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
  .ins:active { background: var(--key); }
  .cr { color: var(--teal); margin-left: 5px; font-size: 0.65rem; }
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
    margin-top: 12px;
    flex: 0 0 auto;
  }
</style>
