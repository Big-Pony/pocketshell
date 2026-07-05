<script lang="ts">
  import type { Terminal } from "@xterm/xterm";
  import { onMount } from "svelte";
  import { Connection, type ConnStatus } from "./lib/connection";
  import { registerDevHelpers, unregisterDevHelpers } from "./lib/dev-helpers";
  import { mergeSessions, tombstone, closeTab as closeTabFn, type LocalSession } from "./lib/session-view";
  import { clampSplit, type BottomPanel } from "./lib/shell";
  import TerminalView from "./components/Terminal.svelte";
  import SessionTabs from "./components/SessionTabs.svelte";
  import TaskPanel from "./components/TaskPanel.svelte";
  import FilePanel from "./components/FilePanel.svelte";
  import FilePreview from "./components/FilePreview.svelte";
  import BottomBar from "./components/BottomBar.svelte";
  import { openFileTab, closeFileTab, fileTabId, cycle, stepClamp, type TopTab } from "./lib/top-tabs";
  import DeviceManager from "./components/DeviceManager.svelte";
  import Keyboard from "./components/Keyboard.svelte";
  import SnippetPanel from "./components/SnippetPanel.svelte";
  import SettingsPanel from "./components/SettingsPanel.svelte";
  import type { AppCommand } from "./lib/input-router";
  import { begin, beginLine, moveFocus, range, reset, type SelState } from "./lib/terminal-select";
  import { detectSwipe } from "./lib/swipe";
  import { loadSettings, saveSettings, type Settings } from "./lib/settings";
  import { getAgentPubKey, getAgentAddr } from "./lib/keystore";
  import { loadProjectRoot } from "./lib/file-tree";

  function defaultAgentUrl(): string {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    // In dev (vite), the page is on :5173 but the agent listens on :8722.
    // In production (agent-embedded), the page and WebSocket share the same port.
    const host = import.meta.env.DEV ? `${location.hostname}:8722` : location.host;
    return `${scheme}://${host}`;
  }

  const wsUrl = getAgentAddr() ?? defaultAgentUrl();

  let sessions = $state<LocalSession[]>([]);
  let activeId = $state("");
  let backgrounded = $state<Set<string>>(new Set());
  let bottomPanel = $state<BottomPanel>("kbd");
  let splitRatio = $state(0.6);
  let fullscreen = $state(false);
  let settings = $state<Settings>(loadSettings());
  let fileTabs = $state<TopTab[]>([]);
  let activeTop = $state("");
  let sel = $state<SelState>(reset());
  let selCount = $state(0);
  let topEl: HTMLDivElement | null = null;
  let selecting = $derived(sel.mode !== "idle");
  let selMode = $derived(sel.mode);

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

  onMount(() => {
    registerDevHelpers({
      openFile,
      openPanel,
      getState: () => ({
        status,
        projectRoot: loadProjectRoot(),
        activePanel: bottomPanel,
        fileTabs: fileTabs.map((t) => t.id),
        activeId: activeTopId,
      }),
    });
    topEl?.addEventListener("pointerdown", onTopPointerDown, { capture: true });
    topEl?.addEventListener("pointerup", onTopPointerUp, { capture: true });
    return () => {
      unregisterDevHelpers();
      topEl?.removeEventListener("pointerdown", onTopPointerDown, { capture: true });
      topEl?.removeEventListener("pointerup", onTopPointerUp, { capture: true });
    };
  });

  // Top-tab list = live sessions minus the ones sent to background.
  const topSessions = $derived(sessions.filter((s) => !backgrounded.has(s.name)));
  const topOrder = $derived([...topSessions.map((s) => s.name), ...fileTabs.map((t) => t.id)]);
  const activeTopId = $derived(activeTop && topOrder.includes(activeTop) ? activeTop : (activeId || topOrder[0] || ""));

  function newSession(name: string) { conn.newSession(name); activeId = name; backgrounded.delete(name); backgrounded = new Set(backgrounded); }
  function selectSession(name: string) {
    cancelSelection();
    activeId = name;
    if (backgrounded.has(name)) { backgrounded.delete(name); backgrounded = new Set(backgrounded); }
  }
  function renameSession(name: string, next: string) {
    conn.renameSession(name, next);
    sessions = sessions.map((s) => (s.name === name ? { ...s, name: next } : s));
    if (activeId === name) activeId = next;
  }
  function killSession(name: string) { cancelSelection(); conn.kill(name); }
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
    void navigator.clipboard?.writeText(text.replace(/\n+$/, "\n")).then(() => showToast("已复制可见输出"));
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

  function openFile(path: string, mode: "code" | "diff" = "code") {
    fileTabs = openFileTab(fileTabs, path, mode);
    activeTop = fileTabId(path, mode);
    if (fullscreen) fullscreen = false;
  }
  function closeFile(id: string) {
    fileTabs = closeFileTab(fileTabs, id);
    if (activeTop === id) activeTop = topOrder.filter((x) => x !== id)[0] ?? activeId ?? "";
  }
  function selectTop(id: string) {
    cancelSelection();
    if (id.startsWith("file:")) { activeTop = id; }
    else { activeTop = ""; selectSession(id); }
  }

  function shiftTab(delta: number) {
    if (!topOrder.length) return;
    const next = cycle(topOrder, activeTopId, delta);
    selectTop(next);
  }

  function toBackground() {
    if (!activeId) return;
    cancelSelection();
    backgrounded.add(activeId);
    backgrounded = new Set(backgrounded);
    activeId = topSessions[0]?.name ?? "";
  }

  function activeTerm() { return terms.get(activeId); }

  function applySel(t: import("@xterm/xterm").Terminal) {
    const r = range(sel, t.cols);
    t.select(r.col, r.row, r.length);
    selCount = sel.mode === "line" ? r.length / t.cols : r.length;
  }

  // Scroll the viewport so `row` stays visible — lets line/char selection reach
  // scrolled-off history so it can be copied.
  function revealRow(t: import("@xterm/xterm").Terminal, row: number) {
    const b = t.buffer.active;
    const top = b.viewportY;
    const bot = top + t.rows - 1;
    if (row < top) t.scrollToLine(row);
    else if (row > bot) t.scrollToLine(Math.max(0, row - t.rows + 1));
  }

  function cancelSelection() {
    if (sel.mode === "idle") return;
    activeTerm()?.clearSelection();
    sel = reset();
    selCount = 0;
  }

  function writeClip(text: string, ok: string) {
    const p = navigator.clipboard?.writeText?.(text);
    if (p) p.then(() => showToast(ok)).catch(() => showToast("无法访问剪贴板"));
    else showToast("无法访问剪贴板");
  }

  function runCommand(c: AppCommand) {
    switch (c.type) {
      case "prevTab": shiftTab(-1); break;
      case "nextTab": shiftTab(1); break;
      case "gotoTab": { const s = topSessions[c.index]; if (s) selectTop(s.name); break; }
      case "newSession": { const n = `s${sessions.length + 1}`; newSession(n); break; }
      case "toBackground": toBackground(); break;
      case "scrollUp": terms.get(activeId)?.scrollPages(-1); break;
      case "scrollDown": terms.get(activeId)?.scrollPages(1); break;
      case "toggleFullscreen": cancelSelection(); fullscreen = !fullscreen; break;
      case "copyVisible": copyOutput(activeId); break;
      case "renameSession": {
        const next = prompt("新的会话名称", activeId);
        if (next && next.trim() && next !== activeId) renameSession(activeId, next.trim());
        break;
      }
      case "selBegin": {
        const t = activeTerm(); if (!t) break;
        const b = t.buffer.active;
        sel = begin({ row: b.baseY + b.cursorY, col: b.cursorX });
        t.focus();
        applySel(t);
        break;
      }
      case "selMove": {
        const t = activeTerm(); if (!t || sel.mode === "idle") break;
        sel = moveFocus(sel, c.dir, { cols: t.cols, maxRow: t.buffer.active.length - 1 });
        applySel(t);
        revealRow(t, sel.focus.row);
        break;
      }
      case "lineUp":
      case "lineDown": {
        // Whole-line selection that hops through the buffer (incl. scrollback),
        // scrolling the viewport to follow so historical lines can be copied.
        const t = activeTerm(); if (!t) break;
        const b = t.buffer.active;
        const maxRow = b.length - 1;
        if (sel.mode !== "line") {
          // First hop grabs the last real output line (just above the prompt).
          const startRow = Math.max(0, Math.min(maxRow, b.baseY + b.cursorY - 1));
          sel = beginLine(startRow);
          t.focus();
        } else {
          sel = moveFocus(sel, c.type === "lineUp" ? "up" : "down", { cols: t.cols, maxRow });
        }
        applySel(t);
        revealRow(t, sel.focus.row);
        break;
      }
      case "selCancel": cancelSelection(); break;
      case "selCopy": {
        const t = activeTerm(); if (!t) break;
        const text = t.getSelection();
        if (!text) { showToast("无选区"); break; }
        writeClip(text, "已复制选区");
        cancelSelection();
        break;
      }
      case "copyAfter": {
        const t = activeTerm(); if (!t) break;
        const b = t.buffer.active;
        const startRow = b.baseY + b.cursorY, startCol = b.cursorX;
        let text = "";
        for (let i = startRow; i < b.length; i++) {
          const line = b.getLine(i)?.translateToString(true) ?? "";
          text += (i === startRow ? line.slice(startCol) : line) + "\n";
        }
        writeClip(text.replace(/\n+$/, "\n"), "已复制光标之后内容");
        cancelSelection();
        break;
      }
      case "selectAllCopy": {
        const t = activeTerm(); if (!t) break;
        t.selectAll();
        writeClip(t.getSelection(), "已全选并复制");
        t.clearSelection();
        sel = reset();
        selCount = 0;
        break;
      }
      case "paste": {
        if (!activeId) break;
        const rd = navigator.clipboard?.readText?.();
        if (rd) rd.then((text) => { if (text) conn.sendInput(activeId, new TextEncoder().encode(text)); })
                 .catch(() => showToast("无法访问剪贴板"));
        else showToast("无法访问剪贴板");
        break;
      }
    }
  }

  // ---- Top-area swipe to switch tabs ----
  let swipeStart: { x: number; y: number; t: number } | null = null;
  function onTopPointerDown(e: PointerEvent) {
    swipeStart = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  }
  function onTopPointerUp(e: PointerEvent) {
    if (!swipeStart) return;
    const g = { dx: e.clientX - swipeStart.x, dy: e.clientY - swipeStart.y, dt: e.timeStamp - swipeStart.t };
    swipeStart = null;
    const dir = detectSwipe(g);
    if (!dir) return;
    const delta = dir === "left" ? 1 : -1; // left swipe -> next tab
    const next = stepClamp(topOrder, activeTopId, delta);
    if (next && next !== activeTopId) selectTop(next);
  }

  // ---- Toast ----
  let toastText = $state("");
  let toastVisible = $state(false);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(text: string) {
    toastText = text;
    toastVisible = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastVisible = false), 1800);
  }

  const statusText: Record<ConnStatus, string> = {
    online: "已连接",
    connecting: "连接中…",
    offline: "已断开",
  };
</script>

<div class="shell">
  <div class="topbar">
    <span class="brand mono">◧ PocketShell</span>
    <span class="version">S5</span>
    <div class="conn">
      <span class="conn-dot" class:online={status === "online"} class:connecting={status === "connecting"} class:offline={status === "offline"}></span>
      <span class="conn-text mono">{statusText[status]}</span>
    </div>
  </div>

  <div class="tabs-wrap">
    <SessionTabs sessions={topSessions} activeId={activeTopId} onSelect={selectTop} onNew={newSession} onClose={closeTab} />
    {#if fileTabs.length}
      <nav class="file-tabs">
        {#each fileTabs as t (t.id)}
          <button class="ftab" class:active={activeTopId === t.id} onclick={() => selectTop(t.id)}>
            <span class="ft-name">{t.title}</span>
            <span class="ft-x" role="button" tabindex="0"
              onclick={(e) => { e.stopPropagation(); closeFile(t.id); }}
              onkeydown={(e) => { if (e.key === "Enter") { e.stopPropagation(); closeFile(t.id); } }}>×</span>
          </button>
        {/each}
      </nav>
    {/if}
  </div>

  {#if notice}<div class="notice">{notice}</div>{/if}
  {#if status !== "online"}
    <div class="banner">⚠ 连接已断开 · 会话由服务器托管，任务继续运行 · 正在重连…</div>
  {/if}

  <div class="top" style="flex: {topFlex} 1 0;" role="application" aria-label="终端与文件预览" bind:this={topEl}>
    {#each topSessions as s (s.name)}
      <TerminalView
        {conn}
        sessionId={s.name}
        active={activeTopId === s.name}
        closed={s.closed ?? false}
        fontSize={settings.fontSize}
        onReady={(id, t) => terms.set(id, t)}
      />
    {/each}
    {#each fileTabs as t (t.id)}
      <FilePreview {conn} path={t.path} mode={t.mode} active={activeTopId === t.id} />
    {/each}
    {#if topSessions.length === 0 && fileTabs.length === 0}
      <div class="hint">
        <div class="hint-title">还没有会话</div>
        <div class="hint-body">点击上方 ＋ 新建，或在键盘上按 Fn + n</div>
      </div>
    {/if}
  </div>

  {#if !fullscreen}
    <div class="divider" role="separator" onpointerdown={onDividerDown} onpointermove={onDividerMove} onpointerup={onDividerUp}>
      <div class="grip"></div>
    </div>
    <div class="bottom" style="flex: {1 - topFlex} 1 0;">
      {#if bottomPanel === "file"}
        <FilePanel {conn} onOpenFile={(p) => openFile(p, "code")} onOpenDiff={(p) => openFile(p, "diff")} onCd={(p) => sendActive('cd ' + JSON.stringify(p) + '\n')} />
      {:else if bottomPanel === "task"}
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
        <Keyboard onText={sendActive} onCommand={runCommand} vibrate={settings.vibrate} layout={settings.layout} {selecting} {selCount} {selMode} />
      {:else if bottomPanel === "snip"}
        <SnippetPanel {conn} onInsert={sendActive} />
      {/if}
    </div>
  {/if}

  <BottomBar active={bottomPanel} taskBadge={sessions.some((s) => s.state === "wait")} onSelect={openPanel} />
</div>

{#if toastVisible}
  <div class="toast" class:visible={toastVisible}>{toastText}</div>
{/if}

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    background: var(--bg);
    overflow: hidden;
    position: relative;
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px 6px;
    background: var(--bg);
    flex: 0 0 auto;
  }
  .brand {
    font-weight: 700;
    letter-spacing: 0.4px;
    font-size: 0.85rem;
    color: var(--teal);
  }
  .version {
    font-size: 0.62rem;
    color: var(--dim);
  }
  .conn {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.7rem;
    color: var(--dim);
  }
  .conn-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dimmer);
  }
  .conn-dot.online { background: var(--teal); box-shadow: 0 0 6px var(--teal); }
  .conn-dot.connecting { background: var(--amber); box-shadow: 0 0 6px var(--amber); }
  .conn-dot.offline { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .conn-text {
    min-width: 3em;
    text-align: right;
  }

  .tabs-wrap {
    flex: 0 0 auto;
    position: relative;
    overflow: hidden;
    background: var(--bg);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px;
  }
  .file-tabs {
    display: flex;
    gap: 4px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }
  .ftab {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    color: var(--dim);
    padding: 4px 6px;
    font-size: 0.68rem;
    white-space: nowrap;
  }
  .ftab.active { background: var(--panel2); color: var(--text); border-color: var(--line-strong); }
  .ft-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
  .ft-x { padding: 0 2px; color: var(--dimmer); }

  .banner {
    background: var(--red-dark);
    color: var(--amber);
    font-size: 0.72rem;
    padding: 6px 12px;
    border-bottom: 1px solid #55402c;
    text-align: center;
    flex: 0 0 auto;
  }
  .notice {
    background: var(--red-dark);
    color: var(--red);
    padding: 8px 12px;
    font-size: 13px;
    border-bottom: 1px solid #55402c;
    flex: 0 0 auto;
  }

  .top {
    position: relative;
    min-height: 0;
    overflow: hidden;
    background: var(--panel2);
    border-top: 1px solid var(--line-strong);
  }
  .hint {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--dim);
    text-align: center;
    gap: 6px;
  }
  .hint-title { font-size: 15px; color: var(--text); }
  .hint-body { font-size: 12px; }

  .divider {
    flex: 0 0 auto;
    background: var(--panel);
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    padding: 6px 0;
    touch-action: none;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .grip {
    width: 44px;
    height: 4px;
    border-radius: 2px;
    background: var(--keyhi);
  }

  .bottom {
    min-height: 0;
    overflow: hidden;
    background: var(--bg);
    display: flex;
    flex-direction: column;
  }

  .toast {
    position: absolute;
    left: 50%;
    bottom: 110px;
    transform: translateX(-50%) translateY(8px);
    background: #243039;
    border: 1px solid var(--line-strong);
    color: var(--text);
    font-size: 0.72rem;
    padding: 8px 14px;
    border-radius: var(--radius-xl);
    opacity: 0;
    transition: 0.2s;
    pointer-events: none;
    white-space: nowrap;
    z-index: 20;
  }
  .toast.visible {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
</style>
