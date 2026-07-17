<script lang="ts">
  import { stateDotClass, needsKillConfirm, actionLabel } from "../lib/session-view";
  import ContextMenu from "./ContextMenu.svelte";

  let {
    sessions,
    onSelect,
    onRename,
    onKill,
    onCopy,
    onClose,
  }: {
    sessions: import("../lib/session-view").LocalSession[];
    onSelect: (name: string) => void;
    onRename: (name: string, newName: string) => void;
    onKill: (name: string) => void;
    onCopy: (name: string) => void;
    onClose: (name: string) => void;
  } = $props();

  let menuFor = $state<string | null>(null);   // session name whose menu is open
  let menuAnchor = $state<HTMLElement | undefined>();
  let confirmKill = $state<string | null>(null); // session name pending kill confirm

  function openMenu(name: string, anchor: HTMLElement) {
    menuFor = name;
    menuAnchor = anchor;
  }
  function closeMenu() {
    menuFor = null;
  }
  function doRename(name: string) {
    const next = prompt("Rename session", name);
    closeMenu();
    if (next && next.trim() && next.trim() !== name) onRename(name, next.trim());
  }
  function requestKill(s: import("../lib/session-view").LocalSession) {
    closeMenu();
    if (needsKillConfirm(s.state)) confirmKill = s.name;
    else onKill(s.name);
  }

  const stateLabel: Record<string, string> = { run: "运行中", wait: "等待输入", done: "已结束", idle: "后台运行" };
</script>

<div class="tp">
<ul class="list">
  {#each sessions as s (s.name)}
    <li class="sess-card">
      <div class="row-wrap">
        <button
          class="row"
          onclick={() => onSelect(s.name)}
        >
          <span class="dot {stateDotClass(s.state)}"></span>
          <span class="info">
            <span class="name mono">{s.name}<em class={s.state === "wait" ? "w" : ""}>{stateLabel[s.state]}</em></span>
            <span class="last mono">{s.lastLine}</span>
          </span>
          <span class="act">{actionLabel(s)}</span>
        </button>
        <button class="more" aria-label="更多"
          onclick={(e) => { e.stopPropagation(); openMenu(s.name, e.currentTarget); }}>⋯</button>
      </div>

      {#if menuFor === s.name}
        <ContextMenu
          onClose={closeMenu}
          anchor={menuAnchor}
          items={[
            { label: "重命名", icon: "✎", onSelect: () => doRename(s.name) },
            { label: "复制输出", icon: "📋", onSelect: () => onCopy(s.name) },
            ...(s.closed
              ? [{ label: "关闭标签", icon: "×", onSelect: () => onClose(s.name) }]
              : [{ label: "终止", icon: "⏹", danger: true, onSelect: () => requestKill(s) }]),
          ]}
        />
      {/if}

      {#if confirmKill === s.name}
        <div class="confirm-overlay" role="dialog" aria-modal="true">
          <div class="confirm-dlg">
            <div class="dlg-title">终止 {s.name}</div>
            <div class="dlg-body">{s.state === "idle" ? "无法确认该会话是否在运行，终止可能中断任务。" : "会话正在运行中，终止后任务将中断。"}确定要终止吗？</div>
            <div class="dlg-btns">
              <button onclick={() => (confirmKill = null)}>取消</button>
              <button class="danger" onclick={() => { onKill(s.name); confirmKill = null; }}>终止</button>
            </div>
          </div>
        </div>
      {/if}
    </li>
  {/each}
  {#if sessions.length === 0}
    <li class="empty">No sessions. Tap ＋ to create one.</li>
  {/if}
  <li class="pnote">
    <b>断线保护</b>：以上会话全部由服务器端 Agent（tmux）托管，App 只是 attach 上去的窗口。
  </li>
</ul>

</div>

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 8px;
    overflow-y: auto;
    flex: 1;
  }
  .sess-card {
    margin-bottom: 8px;
    position: relative;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    border: 0;
    background: var(--panel);
    border: 1px solid var(--line-soft);
    border-radius: var(--radius-lg);
    color: inherit;
    padding: 11px 12px;
    text-align: left;
    user-select: none;
  }
  .row:active { background: var(--panel2); }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .dot-run { background: var(--ok); box-shadow: 0 0 5px var(--ok); animation: pulse 1.4s infinite; }
  .dot-wait { background: var(--amber); animation: pulse 0.9s infinite; }
  .dot-done { background: var(--dimmer); }
  .dot-idle { background: var(--blue); }
  @keyframes pulse { 50% { opacity: 0.35; } }

  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .name { font-size: 0.8rem; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .name em {
    font-style: normal;
    font-size: 0.64rem;
    font-weight: 400;
    color: var(--dim);
  }
  .name em.w { color: var(--amber); }
  .last { color: var(--dimmer); font-size: 0.68rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act {
    font-size: 0.7rem;
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--panel2);
    padding: 6px 14px;
    flex: 0 0 auto;
  }

  .confirm-overlay {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: var(--overlay-bg);
    display: grid;
    place-items: center;
  }
  .confirm-dlg {
    background: var(--dlg-bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    padding: 20px;
    width: min(280px, 80vw);
    text-align: center;
    box-shadow: var(--pop-shadow);
  }
  .dlg-title { font-size: 0.85rem; font-weight: 700; margin-bottom: 6px; }
  .dlg-body { font-size: 0.7rem; color: var(--dim); margin-bottom: 16px; line-height: 1.5; }
  .dlg-btns { display: flex; gap: 8px; }
  .dlg-btns button {
    flex: 1;
    padding: 9px 0;
    border-radius: var(--radius-md);
    border: 1px solid var(--line);
    font-size: 0.75rem;
    background: var(--key);
    color: var(--text);
  }
  .dlg-btns button.danger { background: var(--red); color: #fff; border-color: transparent; }

  .tp { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .row-wrap { display: flex; align-items: center; }
  .row { flex: 1; min-width: 0; }
  .more {
    flex: 0 0 auto;
    background: transparent;
    border: 0;
    color: var(--dim);
    padding: 0 10px;
    font-size: 1rem;
    line-height: 1;
  }
  .more:active { color: var(--text); }
  .list { min-height: 0; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
  .empty { padding: 16px; color: var(--dim); text-align: center; }
  .pnote {
    font-size: 0.68rem;
    color: var(--dimmer);
    background: var(--panel);
    border: 1px solid var(--line-soft);
    border-radius: var(--radius-lg);
    padding: 9px 12px;
    line-height: 1.7;
    margin-top: 4px;
  }
  .pnote b { color: var(--dim); font-weight: 600; }
</style>
