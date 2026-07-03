<script lang="ts">
  import type { Terminal } from "@xterm/xterm";
  import type { SessionMeta } from "./lib/protocol";
  import { Connection } from "./lib/connection";
  import TerminalView from "./components/Terminal.svelte";
  import SessionTabs from "./components/SessionTabs.svelte";
  import TaskPanel from "./components/TaskPanel.svelte";

  const url = `ws://${location.hostname}:8722`;
  const conn = new Connection({ url });

  let sessions = $state<SessionMeta[]>([]);
  let activeId = $state("");
  let panelOpen = $state(false);
  let notice = $state("");
  const terms = new Map<string, Terminal>();

  conn.onSessions((list) => {
    sessions = list;
    if (!activeId && list.length) activeId = list[0].name;
  });
  conn.onExit((f) => {
    // Mark done locally; keep the tab so the last screen stays visible.
    sessions = sessions.map((s) => (s.name === f.sessionId ? { ...s, state: "done" } : s));
  });
  conn.onError((f) => {
    notice = `${f.code}: ${f.message}`;
    setTimeout(() => (notice = ""), 4000);
  });

  // Pull the current list once connected (also covers reconnecting to a running agent).
  conn.listSessions();

  function newSession(name: string) {
    conn.newSession(name);
    activeId = name;
  }
  function selectSession(name: string) {
    activeId = name;
    panelOpen = false;
  }
  function renameSession(name: string, next: string) {
    conn.renameSession(name, next);
    if (activeId === name) activeId = next;
  }
  function killSession(name: string) {
    conn.kill(name);
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
  <SessionTabs {sessions} {activeId} onSelect={selectSession} onNew={newSession} />

  <div class="main">
    {#each sessions as s (s.name)}
      <TerminalView
        {conn}
        sessionId={s.name}
        active={s.name === activeId}
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
      />
    </div>
  {/if}

  {#if notice}<div class="notice">{notice}</div>{/if}
</div>

<style>
  .shell { display: flex; flex-direction: column; height: 100dvh; background: #000; }
  .main { position: relative; flex: 1; min-height: 0; }
  .hint { color: #777; padding: 24px; text-align: center; }
  .panel-toggle { position: fixed; right: 12px; bottom: 12px; padding: 10px 14px;
                  background: #2d4; color: #000; border: 0; border-radius: 8px; z-index: 10; }
  .panel { position: fixed; left: 0; right: 0; bottom: 56px; max-height: 50dvh; overflow-y: auto; z-index: 9; }
  .notice { position: fixed; top: 0; left: 0; right: 0; background: #a33; color: #fff;
            padding: 8px 12px; font-size: 13px; z-index: 20; }
</style>
