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
    <span>快捷指令</span>
    <button onclick={() => (adding = !adding)}>{adding ? "取消" : "＋ 自定义"}</button>
  </div>

  {#if adding}
    <div class="sp-form">
      <input bind:value={form.group} placeholder="分组，如 项目" />
      <input bind:value={form.label} placeholder="显示名，如 build" />
      <input bind:value={form.command} placeholder="命令，如 npm run build" />
      <label><input type="checkbox" bind:checked={form.autoEnter} /> 自动回车 ⏎</label>
      <button class="save" onclick={submit}>保存</button>
    </div>
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

<style>
  .sp { padding: 8px; color: #ddd; }
  .sp-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .sp-head button { background: #2d4; color: #000; border: 0; border-radius: 6px; padding: 4px 10px; font-size: 12px; }
  .sp-form { display: flex; flex-direction: column; gap: 6px; background: #141414; padding: 8px; border-radius: 8px; margin-bottom: 8px; }
  .sp-form input { background: #111; color: #eee; border: 1px solid #333; border-radius: 6px; padding: 6px; }
  .sp-form .save { background: #2d4; color: #000; border: 0; border-radius: 6px; padding: 6px; }
  .sp-group { color: #888; font-size: 12px; margin: 8px 0 4px; }
  .sp-items { display: flex; flex-wrap: wrap; gap: 6px; }
  .sp-row { display: flex; align-items: center; background: #1e1e1e; border-radius: 6px; }
  .ins { background: none; color: #eee; border: 0; padding: 6px 10px; font-size: 13px; }
  .cr { color: #2d4; margin-left: 4px; }
  .del { background: none; color: #e66; border: 0; padding: 6px 8px; }
</style>
