<script lang="ts">
  import type { Terminal } from "@xterm/xterm";
  import { Connection, type ConnStatus } from "./lib/connection";
  import { mergeSessions, tombstone, closeTab as closeTabFn, type LocalSession } from "./lib/session-view";
  import { clampSplit, type BottomPanel } from "./lib/shell";
  import TerminalView from "./components/Terminal.svelte";
  import SessionTabs from "./components/SessionTabs.svelte";
  import TaskPanel from "./components/TaskPanel.svelte";
  import BottomBar from "./components/BottomBar.svelte";
  import DeviceManager from "./components/DeviceManager.svelte";
  import Keyboard from "./components/Keyboard.svelte";
  import SnippetPanel from "./components/SnippetPanel.svelte";
  import SettingsPanel from "./components/SettingsPanel.svelte";
  import type { AppCommand } from "./lib/input-router";
  import { loadSettings, saveSettings, type Settings } from "./lib/settings";
  import { getAgentPubKey, getAgentAddr } from "./lib/keystore";

  const wsUrl = getAgentAddr() ?? `ws://${location.hostname}:8722`;

  let sessions = $state<LocalSession[]>([]);
  let activeId = $state("");
  let backgrounded = $state<Set<string>>(new Set());
  let bottomPanel = $state<BottomPanel>("kbd");
  let splitRatio = $state(0.6);
  let fullscreen = $state(false);
  let settings = $state<Settings>(loadSettings());

  // App owns settings so they actually apply: fontSize flows to every terminal
  // (reactive prop below), vibrate/layout flow to the keyboard.
  function applySettings(next: Settings) {
    settings = next;
    saveSettings(next);
  }

  function openPanel(p: BottomPanel) {
    bottomPanel = p;
    fullscreen = false; // leaving fullscreen — otherwise the bottom region stays hidden
  }
  let notice = $state(
    !getAgentPubKey()
      ? "未配置 Agent 公钥：打开「设置 → 设备管理」粘贴配对串完成配对"
      : ""
  );

  const conn = new Connection({ url: wsUrl });
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

  // Top-tab list = live sessions minus the ones sent to background.
  const topSessions = $derived(sessions.filter((s) => !backgrounded.has(s.name)));

  function newSession(name: string) { conn.newSession(name); activeId = name; backgrounded.delete(name); backgrounded = new Set(backgrounded); }
  function selectSession(name: string) {
    activeId = name;
    if (backgrounded.has(name)) { backgrounded.delete(name); backgrounded = new Set(backgrounded); }
  }
  function renameSession(name: string, next: string) {
    conn.renameSession(name, next);
    sessions = sessions.map((s) => (s.name === name ? { ...s, name: next } : s));
    if (activeId === name) activeId = next;
  }
  function killSession(name: string) { conn.kill(name); }
  function closeTab(name: string) {
    conn.detach(name);
    sessions = closeTabFn(sessions, name);
    terms.delete(name);
    if (activeId === name) activeId = topSessions[0]?.name ?? "";
  }
  function copyOutput(name: string) {
    const term = terms.get(name);
    if (!term) return;
    const buf = term.buffer.active;
    let text = "";
    for (let i = 0; i < buf.length; i++) text += buf.getLine(i)?.translateToString(true) + "\n";
    void navigator.clipboard?.writeText(text.replace(/\n+$/, "\n"));
  }

  // ---- Divider drag + double-tap fullscreen ----
  let dragging = false;
  let lastTapAt = 0;
  function onDividerDown(e: PointerEvent) {
    const now = e.timeStamp;
    if (now - lastTapAt < 300) { fullscreen = !fullscreen; lastTapAt = 0; return; }
    lastTapAt = now;
    dragging = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onDividerMove(e: PointerEvent) {
    if (!dragging) return;
    const h = window.innerHeight;
    splitRatio = clampSplit(e.clientY / h);
  }
  function onDividerUp(e: PointerEvent) {
    dragging = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  const topFlex = $derived(fullscreen ? 1 : splitRatio);

  function sendActive(text: string) {
    if (!activeId) return;
    conn.sendInput(activeId, new TextEncoder().encode(text));
  }

  function shiftTab(delta: number) {
    const list = topSessions;
    if (!list.length) return;
    const i = Math.max(0, list.findIndex((s) => s.name === activeId));
    const next = list[(i + delta + list.length) % list.length];
    if (next) activeId = next.name;
  }

  function toBackground() {
    if (!activeId) return;
    backgrounded.add(activeId);
    backgrounded = new Set(backgrounded);
    activeId = topSessions[0]?.name ?? "";
  }

  function runCommand(c: AppCommand) {
    switch (c.type) {
      case "prevTab": shiftTab(-1); break;
      case "nextTab": shiftTab(1); break;
      case "gotoTab": { const s = topSessions[c.index]; if (s) activeId = s.name; break; }
      case "newSession": { const n = `s${sessions.length + 1}`; newSession(n); break; }
      case "toBackground": toBackground(); break;
      case "scrollUp": terms.get(activeId)?.scrollPages(-1); break;
      case "scrollDown": terms.get(activeId)?.scrollPages(1); break;
      case "toggleFullscreen": fullscreen = !fullscreen; break;
      case "copyVisible": copyOutput(activeId); break;
      case "renameSession": {
        const next = prompt("新的会话名称", activeId);
        if (next && next.trim() && next !== activeId) renameSession(activeId, next.trim());
        break;
      }
    }
  }
</script>

<div class="shell">
  <div class="topbar">
    <span class="conn-dot" class:online={status === "online"} class:connecting={status === "connecting"} class:offline={status === "offline"}></span>
    <SessionTabs sessions={topSessions} {activeId} onSelect={selectSession} onNew={newSession} onClose={closeTab} />
  </div>

  {#if notice}<div class="notice">{notice}</div>{/if}
  {#if status !== "online"}
    <div class="banner">连接断开，正在重连…</div>
  {/if}

  <div class="top" style="flex: {topFlex} 1 0;">
    {#each topSessions as s (s.name)}
      <TerminalView
        {conn}
        sessionId={s.name}
        active={s.name === activeId}
        closed={s.closed ?? false}
        fontSize={settings.fontSize}
        onReady={(id, t) => terms.set(id, t)}
      />
    {/each}
    {#if topSessions.length === 0}
      <div class="hint">No session yet. Tap ＋ above to start one.</div>
    {/if}
  </div>

  {#if !fullscreen}
    <div class="divider" role="separator" onpointerdown={onDividerDown} onpointermove={onDividerMove} onpointerup={onDividerUp}></div>
    <div class="bottom" style="flex: {1 - topFlex} 1 0;">
      {#if bottomPanel === "task"}
        <TaskPanel
          {sessions}
          onSelect={selectSession}
          onRename={renameSession}
          onKill={killSession}
          onCopy={copyOutput}
          onClose={closeTab}
        />
      {:else if bottomPanel === "set"}
        <SettingsPanel {conn} {settings} onChange={applySettings} />
      {:else if bottomPanel === "kbd"}
        <Keyboard onText={sendActive} onCommand={runCommand} vibrate={settings.vibrate} layout={settings.layout} />
      {:else if bottomPanel === "snip"}
        <SnippetPanel {conn} onInsert={sendActive} />
      {/if}
    </div>
  {/if}

  <BottomBar active={bottomPanel} taskBadge={sessions.some((s) => s.state === "wait")} onSelect={openPanel} />
</div>

<style>
  .shell { display: flex; flex-direction: column; height: 100dvh; background: #000; }
  .topbar { display: flex; align-items: center; gap: 6px; background: #111; }
  .conn-dot { width: 9px; height: 9px; border-radius: 50%; margin-left: 8px; flex: 0 0 auto; }
  .conn-dot.online { background: #2d4; }
  .conn-dot.connecting { background: #fd3; }
  .conn-dot.offline { background: #e33; }
  .banner { background: #a33; color: #fff; padding: 6px 12px; font-size: 13px; text-align: center; }
  .notice { background: #a33; color: #fff; padding: 8px 12px; font-size: 13px; }
  .top { position: relative; min-height: 0; overflow: hidden; }
  .divider { height: 10px; background: #222; cursor: row-resize; flex: 0 0 auto; touch-action: none; }
  .bottom { min-height: 0; overflow: auto; background: #0a0a0a; }
  .hint { color: #777; padding: 24px; text-align: center; }
</style>
