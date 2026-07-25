<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
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
    const next = prompt(tr("tasks.prompt.rename"), name);
    closeMenu();
    if (next && next.trim() && next.trim() !== name) onRename(name, next.trim());
  }
  function requestKill(s: import("../lib/session-view").LocalSession) {
    closeMenu();
    if (needsKillConfirm(s.state)) confirmKill = s.name;
    else onKill(s.name);
  }

</script>

<div class="tp">
<ul class="list">
  {#each sessions as s (s.name)}
    <li class="sess-card" class:live={!s.closed && s.state !== "done"}>
      <button class="row" onclick={() => onSelect(s.name)}>
        <!-- 第一行：状态点 + 会话名 + 状态词 + 动作区 -->
        <span class="r1">
          <span class="dot {stateDotClass(s.state)}"></span>
          <span class="name mono">{s.name}</span>
          <em class="st" class:w={s.state === "wait"}>{$t('tasks.state.' + s.state)}</em>
          <span class="sp"></span>
          {#if s.closed}
            <span class="act act-del" role="button" tabindex="0"
              onpointerdown={(e) => e.stopPropagation()}
              onclick={(e) => { e.stopPropagation(); onClose(s.name); }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClose(s.name); } }}
            >{$t('tasks.action.close')}</span>
          {:else}
            <!-- 主操作（进入/打开）常驻，不收进 ⋯：⋯ 菜单里只有重命名/复制/
                 终止，没有「打开」，收起来会让后台会话失去可见的进入口。
                 拥挤问题靠两行布局解决（状态与输出预览分行），不靠砍按钮。 -->
            <span class="act">{$t('tasks.action.' + actionLabel(s))}</span>
            <span class="more" role="button" tabindex="0" aria-label={$t('common.more')}
              onpointerdown={(e) => e.stopPropagation()}
              onclick={(e) => { e.stopPropagation(); openMenu(s.name, e.currentTarget as HTMLElement); }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openMenu(s.name, e.currentTarget as HTMLElement); } }}
            >⋯</span>
          {/if}
        </span>
        <!-- 第二行：最后一行输出预览 -->
        <span class="last mono">{s.lastLine}</span>
      </button>

      {#if menuFor === s.name}
        <ContextMenu
          onClose={closeMenu}
          anchor={menuAnchor}
          items={[
            { label: $t('tasks.menu.rename'), icon: "✎", onSelect: () => doRename(s.name) },
            { label: $t('tasks.menu.copyOutput'), icon: "📋", onSelect: () => onCopy(s.name) },
            ...(s.closed
              ? [{ label: $t('tasks.menu.closeTab'), icon: "×", onSelect: () => onClose(s.name) }]
              : [{ label: $t('tasks.menu.kill'), icon: "⏹", danger: true, onSelect: () => requestKill(s) }]),
          ]}
        />
      {/if}

      {#if confirmKill === s.name}
        <div class="confirm-overlay" role="dialog" aria-modal="true">
          <div class="confirm-dlg">
            <div class="dlg-title">{$t('tasks.kill.title', { values: { name: s.name } })}</div>
            <div class="dlg-body">{s.state === "idle" ? $t('tasks.kill.bodyIdle') : $t('tasks.kill.bodyRun')}</div>
            <div class="dlg-btns">
              <button onclick={() => (confirmKill = null)}>{$t('common.cancel')}</button>
              <button class="danger" onclick={() => { onKill(s.name); confirmKill = null; }}>{$t('tasks.kill.confirm')}</button>
            </div>
          </div>
        </div>
      {/if}
    </li>
  {/each}
  {#if sessions.length === 0}
    <li class="empty">{$t('tasks.empty')}</li>
  {/if}
  <li class="pnote">
    <b>{$t('tasks.note.title')}</b>{$t('tasks.note.body')}
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
    margin-bottom: 7px;
    position: relative;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: 100%;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    color: inherit;
    padding: 9px 10px;
    text-align: left;
    user-select: none;
    position: relative;
  }
  .row:active { background: var(--panel2); }
  /* 运行中/等待中的会话左侧一道橙色竖条，扫一眼就能从列表里挑出来 */
  .sess-card.live .row::before {
    content: "";
    position: absolute;
    left: -1px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 0 2px 2px 0;
    background: var(--accent);
  }
  .r1 { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; }
  .sp { flex: 1; }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .dot-run { background: var(--ok); box-shadow: 0 0 5px var(--ok); animation: pulse 1.4s infinite; }
  .dot-wait { background: var(--amber); box-shadow: 0 0 5px var(--amber); animation: pulse 0.9s infinite; }
  .dot-done { background: var(--dimmer); }
  .dot-idle { background: var(--blue); }
  @keyframes pulse { 50% { opacity: 0.35; } }

  .name {
    font-size: 0.78rem;
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .st {
    font-style: normal;
    font-size: 0.62rem;
    font-weight: 400;
    color: var(--dim);
    flex: 0 0 auto;
  }
  .st.w { color: var(--amber); }
  .last { color: var(--dimmer); font-size: 0.66rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act {
    font-size: 0.7rem;
    color: var(--primary-text);
    background: var(--primary-bg);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-weight: 600;
    padding: 5px 12px;
    flex: 0 0 auto;
  }

  .act-del { color: var(--red); border-color: var(--line-strong); background: transparent; cursor: pointer; font-weight: 400; }

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
  .dlg-btns button.danger { background: var(--red); color: var(--on-danger); border-color: transparent; }

  .tp { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .more {
    flex: 0 0 auto;
    color: var(--dim);
    padding: 2px 4px;
    font-size: 0.95rem;
    line-height: 1;
  }
  .more:active { color: var(--text); }
  .list { min-height: 0; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
  .empty { padding: 16px; color: var(--dim); text-align: center; }
  .pnote {
    font-size: 0.66rem;
    color: var(--dimmer);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 9px 11px;
    line-height: 1.7;
    margin-top: 3px;
  }
  .pnote b { color: var(--dim); font-weight: 600; }
</style>
