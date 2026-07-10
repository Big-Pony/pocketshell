<script lang="ts">
  import type { Terminal } from "@xterm/xterm";
  import { onMount } from "svelte";
  import { Connection, type ConnStatus } from "./lib/connection";
  import { registerDevHelpers, unregisterDevHelpers } from "./lib/dev-helpers";
  import { mergeSessions, tombstone, closeTab as closeTabFn, nextSessionName, shouldAdopt, type LocalSession } from "./lib/session-view";
  import { clampSplit, type BottomPanel } from "./lib/shell";
  import TerminalView from "./components/Terminal.svelte";
  import TopTabs from "./components/TopTabs.svelte";
  import TaskPanel from "./components/TaskPanel.svelte";
  import FilePanel from "./components/FilePanel.svelte";
  import FilePreview from "./components/FilePreview.svelte";
  import BottomBar from "./components/BottomBar.svelte";
  import { openFileTab, closeFileTab, fileTabId, cycle, stepClamp, appendOrder, removeOrder, visibleOrder, type TopTab } from "./lib/top-tabs";
  import DeviceManager from "./components/DeviceManager.svelte";
  import Keyboard from "./components/Keyboard.svelte";
  import SnippetPanel from "./components/SnippetPanel.svelte";
  import SettingsPanel from "./components/SettingsPanel.svelte";
  import type { AppCommand } from "./lib/input-router";
  import { begin, beginLine, moveFocus, range, reset, type SelState } from "./lib/terminal-select";
  import { detectSwipe } from "./lib/swipe";
  import { loadSettings, saveSettings, type Settings } from "./lib/settings";
  import { loadTabs, saveTabs } from "./lib/tab-store";
  import { getAgentPubKey, getAgentAddr } from "./lib/keystore";
  import { loadProjectRoot, saveProjectRoot, pushRootHistory, loadRootFollow, saveRootFollow } from "./lib/file-tree";
  import { defaultAgentUrl } from "./lib/agent-url";
  import { lastOutput } from "./lib/terminal-output";
  import { fullscreenAction } from "./lib/fullscreen";
  import { emptyCmdLine, feed, type CmdLineState } from "./lib/command-line";
  import { suggest, delta } from "./lib/command-suggest";
  import { CATALOG } from "./lib/command-catalog";

  const wsUrl = getAgentAddr() ?? defaultAgentUrl(import.meta.env.DEV, location);

  let sessions = $state<LocalSession[]>([]);
  let activeId = $state("");
  let backgrounded = $state<Set<string>>(new Set());
  let bottomPanel = $state<BottomPanel>("kbd");
  let splitRatio = $state(0.6);
  let fullscreen = $state(false);
  let pageFullscreen = $state(false);
  function togglePageFullscreen() {
    const action = fullscreenAction(document);
    if (action === "unsupported") { showToast("iOS 请用『添加到主屏幕』获得全屏"); return; }
    if (action === "enter") document.documentElement.requestFullscreen?.().catch(() => showToast("无法进入全屏"));
    else document.exitFullscreen?.().catch(() => {});
  }
  let settings = $state<Settings>(loadSettings());
  let fileTabs = $state<TopTab[]>([]);
  let tabOrder = $state<string[]>([]);
  let activeTop = $state("");
  let sel = $state<SelState>(reset());
  let selCount = $state(0);
  let rootTick = $state(0);
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
  const cmdLines = new Map<string, CmdLineState>();
  let hints = $state<string[]>([]);

  function cmdState(id: string): CmdLineState {
    let s = cmdLines.get(id);
    if (!s) { s = emptyCmdLine(); cmdLines.set(id, s); }
    return s;
  }
  function recomputeHints() {
    const s = cmdLines.get(activeId);
    hints = s && s.trusted ? suggest(s.line, s.history, CATALOG) : [];
  }

  conn.onStatus((s) => (status = s));
  // Guard so restored session tabs are re-attached exactly once (on the first
  // sessions snapshot after a reload). `sessions` is re-broadcast every ~3s, and
  // TerminalView attaches on its own mount + Connection re-attaches on reconnect,
  // so repeating the loop each broadcast would only send redundant attach frames.
  let restoredReattachDone = false;
  conn.onSessions((list) => {
    sessions = mergeSessions(sessions, list);
    // Drop dead sessions from the order + focus so the strip only shows sessions
    // the server still has; re-attach any restored-but-alive session tabs once.
    const alive = new Set(sessions.map((s) => s.name));
    if (!restoredReattachDone) {
      restoredReattachDone = true;
      for (const id of tabOrder) {
        if (!id.startsWith("file:") && alive.has(id)) conn.attach(id);
      }
    }
    tabOrder = tabOrder.filter((id) => id.startsWith("file:") || alive.has(id));
    if (activeId && !alive.has(activeId)) activeId = "";
    if (!activeId) activeId = sessions.find((s) => s.attached && !s.closed)?.name ?? "";
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
    const saved = loadTabs();
    if (saved) {
      fileTabs = saved.fileTabs;
      tabOrder = saved.tabOrder;
      activeTop = saved.activeTop;
      backgrounded = new Set(saved.backgrounded);
      // activeId is re-validated against live sessions once onSessions arrives.
      if (saved.activeId) activeId = saved.activeId;
    }
    const onFsChange = () => { pageFullscreen = !!document.fullscreenElement; };
    document.addEventListener("fullscreenchange", onFsChange);

    registerDevHelpers({
      openFile,
      openPanel,
      sendInput: sendActive,
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
      document.removeEventListener("fullscreenchange", onFsChange);
    };
  });

  // Top-tab list = adopted/live sessions plus tombstones, excluding backgrounded
  // and foreign idle sessions (those only appear in the task panel).
  const topSessions = $derived(
    sessions.filter((s) => !backgrounded.has(s.name) && (s.attached || s.closed))
  );
  const topOrder = $derived(
    visibleOrder(
      tabOrder,
      new Set([...topSessions.map((s) => s.name), ...fileTabs.map((t) => t.id)]),
      topSessions.map((s) => s.name),
    )
  );
  const activeTopId = $derived(activeTop && topOrder.includes(activeTop) ? activeTop : (activeId || topOrder[0] || ""));
  const topTabsView = $derived(topOrder.map((id) => {
    if (id.startsWith("file:")) {
      const f = fileTabs.find((t) => t.id === id)!;
      return { kind: "file" as const, id, title: f.title };
    }
    const s = sessions.find((x) => x.name === id);
    return { kind: "term" as const, id, title: id, state: s?.state ?? "idle", closed: s?.closed ?? false };
  }));

  function newSession(name: string) {
    conn.newSession(name);
    activeId = name;
    backgrounded.delete(name); backgrounded = new Set(backgrounded);
    tabOrder = appendOrder(tabOrder, name);
  }
  function selectSession(name: string) {
    cancelSelection();
    activeId = name;
    if (backgrounded.has(name)) { backgrounded.delete(name); backgrounded = new Set(backgrounded); }
  }
  function enterSession(name: string) {
    const s = sessions.find((x) => x.name === name);
    if (s && shouldAdopt(s)) { newSession(name); return; } // foreign/idle -> adopt (backend ensure attaches)
    selectSession(name);
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
    // Mirror outbound bytes into the per-session command line, except while a
    // full-screen TUI (vim/htop) owns the alternate screen — then hints pause.
    const alt = activeTerm()?.buffer.active.type === "alternate";
    if (!alt) {
      cmdLines.set(activeId, feed(cmdState(activeId), text));
      recomputeHints();
    }
  }

  function onHint(cmd: string) {
    if (!activeId) return;
    const s = cmdState(activeId);
    sendActive(delta(s.line, cmd));
  }

  function openFile(path: string, mode: "code" | "diff" = "code") {
    fileTabs = openFileTab(fileTabs, path, mode);
    const id = fileTabId(path, mode);
    tabOrder = appendOrder(tabOrder, id);
    activeTop = id;
    if (fullscreen) fullscreen = false;
  }
  function closeFile(id: string) {
    fileTabs = closeFileTab(fileTabs, id);
    tabOrder = removeOrder(tabOrder, id);
    if (activeTop === id) activeTop = topOrder.filter((x) => x !== id)[0] ?? activeId ?? "";
  }
  // Close from the top strip's double-tap dialog. File tabs are removed; term
  // tabs are only backgrounded (the tmux session keeps running and reappears in
  // the task panel) — never killed here.
  function closeTopTab(id: string) {
    if (id.startsWith("file:")) { closeFile(id); return; }
    cancelSelection();
    backgrounded.add(id);
    backgrounded = new Set(backgrounded);
    tabOrder = removeOrder(tabOrder, id);
    if (activeId === id) activeId = topSessions.filter((s) => s.name !== id)[0]?.name ?? "";
    if (activeTop === id) activeTop = "";
  }
  function selectTop(id: string) {
    cancelSelection();
    if (id.startsWith("file:")) { activeTop = id; }
    else { activeTop = ""; selectSession(id); }
  }

  // Read the focused tab's real cwd for the file panel's root buttons.
  async function getFocusedPwd(): Promise<{ pwd: string } | { error: string }> {
    if (!activeTopId || activeTopId.startsWith("file:")) return { error: "当前聚焦不是终端，无法获取工作目录" };
    try {
      const r = (await conn.rpc("terminal.pwd", { session: activeTopId })) as { pwd: string };
      if (!r.pwd) return { error: "无法获取该会话的工作目录" };
      return { pwd: r.pwd };
    } catch {
      return { error: "无法获取该会话的工作目录" };
    }
  }

  // Recompute hint bar when the active terminal changes.
  $effect(() => {
    activeId;
    recomputeHints();
  });

  // Project-root-follow: when enabled, switching to a terminal tab re-points the
  // bookmark at that session's cwd and signals FileTree to reload.
  $effect(() => {
    const id = activeTopId;
    if (!loadRootFollow()) return;
    if (!id || id.startsWith("file:")) return;
    void getFocusedPwd().then((r) => {
      if ("pwd" in r) { saveProjectRoot(r.pwd); pushRootHistory(r.pwd); rootTick++; }
    });
  });

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
      case "gotoTab": { const id = topOrder[c.index]; if (id) selectTop(id); break; }
      case "newSession": { const n = nextSessionName(sessions.map((s) => s.name)); newSession(n); break; }
      case "toBackground": toBackground(); break;
      case "scrollUp": terms.get(activeId)?.scrollPages(-1); break;
      case "scrollDown": terms.get(activeId)?.scrollPages(1); break;
      case "toggleFullscreen": cancelSelection(); fullscreen = !fullscreen; break;
      case "copyVisible": {
        const t = activeTerm(); if (!t) { showToast("无终端"); break; }
        const text = lastOutput(t.buffer.active, t.rows);
        if (!text.trim()) { showToast("无输出可复制"); break; }
        writeClip(text, "已复制最后输出");
        break;
      }
      case "renameSession": {
        const next = prompt("新的会话名称", activeId);
        if (next && next.trim() && next !== activeId) renameSession(activeId, next.trim());
        break;
      }
      case "selBegin": {
        const t = activeTerm(); if (!t) break;
        const b = t.buffer.active;
        sel = begin({ row: b.baseY + b.cursorY, col: b.cursorX });
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
      case "togglePageFullscreen": togglePageFullscreen(); break;
      case "clearScreen": if (activeId) sendActive("\x0c"); break;
      case "smartCopy": {
        // Phase 5 req 1+2: system native selection -> keyboard selection -> last output.
        const sys = window.getSelection?.()?.toString() ?? "";
        if (sys.trim()) { writeClip(sys, "已复制选中文本"); break; }
        const t = activeTerm(); if (!t) { showToast("无终端"); break; }
        const kb = t.getSelection();
        if (kb) { writeClip(kb, "已复制选区"); cancelSelection(); break; }
        const text = lastOutput(t.buffer.active, t.rows);
        if (!text.trim()) { showToast("无输出可复制"); break; }
        writeClip(text, "已复制最后输出");
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

  // Persist the open tabs whenever they change (debounced) so a PWA suspend +
  // resume restores the strip instead of falling back to the task panel.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const snapshot = {
      tabOrder,
      fileTabs,
      activeTop,
      activeId,
      backgrounded: [...backgrounded],
    };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveTabs(snapshot), 200);
  });

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
    <button class="fs-btn mono" aria-label={pageFullscreen ? "退出全屏" : "全屏"} onclick={togglePageFullscreen}>
      {pageFullscreen ? "⤡" : "⤢"}
    </button>
  </div>

  <div class="tabs-wrap">
    <TopTabs tabs={topTabsView} activeId={activeTopId} onSelect={selectTop} onNew={newSession} onCloseTab={closeTopTab} />
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
        <FilePanel {conn} onOpenFile={(p) => openFile(p, "code")} onOpenDiff={(p) => openFile(p, "diff")} onCd={(p) => sendActive('cd ' + JSON.stringify(p) + '\n')} {getFocusedPwd} {rootTick} onToast={showToast} />
      {:else if bottomPanel === "task"}
        <TaskPanel
          {sessions}
          onSelect={enterSession}
          onRename={renameSession}
          onKill={killSession}
          onCopy={copyOutput}
          onClose={closeTab}
        />
      {:else if bottomPanel === "set"}
        <SettingsPanel {conn} {settings} onChange={applySettings} />
      {:else if bottomPanel === "kbd"}
        <Keyboard onText={sendActive} onCommand={runCommand} vibrate={settings.vibrate} layout={settings.layout} {selecting} {selCount} {selMode} {hints} {onHint} />
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
  .fs-btn {
    flex: 0 0 auto;
    background: var(--panel2);
    border: 1px solid var(--line);
    color: var(--text);
    border-radius: var(--radius-md);
    padding: 2px 8px;
    font-size: 0.9rem;
    line-height: 1.2;
  }
  .fs-btn:active { background: var(--key); }

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
