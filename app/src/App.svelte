<script lang="ts">
  import type { Terminal } from "@xterm/xterm";
  import { Connection, type ConnStatus } from "./lib/connection";
  import { mergeSessions, tombstone, closeTab as closeTabFn, type LocalSession } from "./lib/session-view";
  import TerminalView from "./components/Terminal.svelte";
  import SessionTabs from "./components/SessionTabs.svelte";
  import TaskPanel from "./components/TaskPanel.svelte";
  import { getAgentPubKey } from "./lib/keystore";

  const url = `ws://${location.hostname}:8722`;
  const conn = new Connection({ url });

  let sessions = $state<LocalSession[]>([]);
  let activeId = $state("");
  let panelOpen = $state(false);
  let notice = $state(
    !getAgentPubKey()
      ? "未配置 Agent 公钥：从 Agent 启动日志复制公钥，设 VITE_AGENT_PUBKEY 或 localStorage['pocketshell.agentPubKey']"
      : ""
  );
  let status = $state<ConnStatus>("connecting");
  const terms = new Map<string, Terminal>();

  conn.onStatus((s) => (status = s));
  conn.onSessions((list) => {
    sessions = mergeSessions(sessions, list);
    if (!activeId && sessions.length) activeId = sessions[0].name;
  });
  conn.onExit((f) => { sessions = tombstone(sessions, f.sessionId); });
  conn.onResync(() => {
    notice = "部分历史超出缓冲、未补齐";
    setTimeout(() => (notice = ""), 4000);
  });
  conn.onError((f) => {
    notice = `${f.code}: ${f.message}`;
    setTimeout(() => (notice = ""), 4000);
  });

  conn.listSessions();

  function newSession(name: string) { conn.newSession(name); activeId = name; }
  function selectSession(name: string) { activeId = name; panelOpen = false; }
  function renameSession(name: string, next: string) {
    conn.renameSession(name, next);
    sessions = sessions.map((s) => (s.name === name ? { ...s, name: next } : s)); // optimistic
    if (activeId === name) activeId = next;
  }
  function killSession(name: string) { conn.kill(name); }
  function closeTab(name: string) {
    conn.detach(name);
    sessions = closeTabFn(sessions, name);
    terms.delete(name);
    if (activeId === name) activeId = sessions[0]?.name ?? "";
  }
  function copyOutput(name: string) {
    const term = terms.get(name);
    if (!term) return;
    const buf = term.buffer.active;
    let text = "";
    for (let i = 0; i < buf.length; i++) text += buf.getLine(i)?.translateToString(true) + "\n";
    void navigator.clipboard?.writeText(text.replace(/\n+$/, "\n"));
  }
</script>

<div class="shell">
  <div class="topbar">
    <span class="conn-dot" class:online={status === "online"} class:connecting={status === "connecting"} class:offline={status === "offline"}></span>
    <SessionTabs {sessions} {activeId} onSelect={selectSession} onNew={newSession} onClose={closeTab} />
  </div>

  {#if status !== "online"}
    <div class="banner">连接断开，正在重连…</div>
  {/if}

  <div class="main">
    {#each sessions as s (s.name)}
      <TerminalView
        {conn}
        sessionId={s.name}
        active={s.name === activeId}
        closed={s.closed ?? false}
        onReady={(id, t) => terms.set(id, t)}
      />
    {/each}
    {#if sessions.length === 0}
      <div class="hint">No session yet. Tap ＋ above to start one.</div>
    {/if}
  </div>

  <button class="panel-toggle" onclick={() => (panelOpen = !panelOpen)}>Tasks</button>
  {#if panelOpen}
    <div class="panel">
      <TaskPanel
        {sessions}
        onSelect={selectSession}
        onRename={renameSession}
        onKill={killSession}
        onCopy={copyOutput}
        onClose={closeTab}
      />
    </div>
  {/if}

  {#if notice}<div class="notice">{notice}</div>{/if}
</div>

<style>
  .shell { display: flex; flex-direction: column; height: 100dvh; background: #000; }
  .topbar { display: flex; align-items: center; gap: 6px; background: #111; }
  .conn-dot { width: 9px; height: 9px; border-radius: 50%; margin-left: 8px; flex: 0 0 auto; }
  .conn-dot.online { background: #2d4; }
  .conn-dot.connecting { background: #fd3; }
  .conn-dot.offline { background: #e33; }
  .banner { background: #a33; color: #fff; padding: 6px 12px; font-size: 13px; text-align: center; }
  .main { position: relative; flex: 1; min-height: 0; }
  .hint { color: #777; padding: 24px; text-align: center; }
  .panel-toggle { position: fixed; right: 12px; bottom: 12px; padding: 10px 14px;
                  background: #2d4; color: #000; border: 0; border-radius: 8px; z-index: 10; }
  .panel { position: fixed; left: 0; right: 0; bottom: 56px; max-height: 50dvh; overflow-y: auto; z-index: 9; }
  .notice { position: fixed; top: 0; left: 0; right: 0; background: #a33; color: #fff;
            padding: 8px 12px; font-size: 13px; z-index: 20; }
</style>
