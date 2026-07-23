<script lang="ts">
  import type { Terminal } from "@xterm/xterm";
  import { onMount } from "svelte";
  import { Connection, type ConnStatus } from "./lib/connection";
  import { registerDevHelpers, unregisterDevHelpers } from "./lib/dev-helpers";
  import { mergeSessions, tombstone, closeTab as closeTabFn, nextSessionName, shouldAdopt, type LocalSession } from "./lib/session-view";
  import { clampSplit, type BottomPanel } from "./lib/shell";
  import TerminalView from "./components/Terminal.svelte";
  import TermCopyOverlay from "./components/TermCopyOverlay.svelte";
  import TopTabs from "./components/TopTabs.svelte";
  import TaskPanel from "./components/TaskPanel.svelte";
  import FilePanel from "./components/FilePanel.svelte";
  import FilePreview from "./components/FilePreview.svelte";
  import BottomBar from "./components/BottomBar.svelte";
  import { openFileTab, closeFileTab, fileTabId, filePathFromTabId, cycle, stepClamp, appendOrder, removeOrder, visibleOrder, type TopTab } from "./lib/top-tabs";
  import DeviceManager from "./components/DeviceManager.svelte";
  import Keyboard from "./components/Keyboard.svelte";
  import SnippetPanel from "./components/SnippetPanel.svelte";
  import SettingsPanel from "./components/SettingsPanel.svelte";
  import UpdateDialog from "./components/UpdateDialog.svelte";
  import type { CheckResult } from "./lib/update";
  import type { AppCommand } from "./lib/input-router";
  import { reset, type SelState } from "./lib/terminal-select";
  import { detectSwipe } from "./lib/swipe";
  import { loadSettings, saveSettings, type Settings } from "./lib/settings";
  import { applyTheme, watchSystem } from "./lib/theme";
  import { loadTabs, saveTabs } from "./lib/tab-store";
  import { getAgentPubKey, getAgentAddr } from "./lib/keystore";
  import { loadProjectRoot, saveProjectRoot, pushRootHistory, loadRootFollow, saveRootFollow } from "./lib/file-tree";
  import { shouldSyncRoot } from "./lib/root-follow";
  import { defaultAgentUrl } from "./lib/agent-url";
  import { sessionFromUrl } from "./lib/notify";
  import { lastOutput } from "./lib/terminal-output";
  import { fullscreenAction } from "./lib/fullscreen";
  import { emptyCmdLine, feed, type CmdLineState } from "./lib/command-line";
  import { suggest, delta } from "./lib/command-suggest";
  import { suggestSlash } from "./lib/slash-catalog";
  import { CATALOG } from "./lib/command-catalog";
  import { t } from "svelte-i18n";
  import { applyLanguage, tr } from "./lib/i18n";

  const wsUrl = getAgentAddr() ?? defaultAgentUrl(import.meta.env.DEV, location);

  let sessions = $state<LocalSession[]>([]);
  let activeId = $state("");
  let backgrounded = $state<Set<string>>(new Set());
  let bottomPanel = $state<BottomPanel>("kbd");
  let splitRatio = $state(0.6);
  let fullscreen = $state(false);
  let copyMode = $state(false); // req 7-5: terminal "copy mode" overlay is open
  let pageFullscreen = $state(false);
  function togglePageFullscreen() {
    const action = fullscreenAction(document);
    if (action === "unsupported") { showToast(tr("app.toast.iosFullscreen")); return; }
    if (action === "enter") document.documentElement.requestFullscreen?.().catch(() => showToast(tr("app.toast.fullscreenFailed")));
    else document.exitFullscreen?.().catch(() => {});
  }
  let settings = $state<Settings>(loadSettings());
  let fileTabs = $state<TopTab[]>([]);
  let tabOrder = $state<string[]>([]);
  let activeTop = $state("");
  let sel = $state<SelState>(reset());
  let selCount = $state(0);
  let rootTick = $state(0);
  let treeTick = $state(0);
  let fileDirty = $state(new Set<string>());
  let pendingEdit = $state<string | null>(null);
  let editingId = $state<string | null>(null); // top-tab id whose editor is open (forces fullscreen)
  let topEl: HTMLDivElement | null = null;
  function setFileDirty(id: string, d: boolean) {
    const next = new Set(fileDirty);
    if (d) next.add(id); else next.delete(id);
    fileDirty = next;
  }
  let selecting = $derived(sel.mode !== "idle");
  let selMode = $derived(sel.mode);

  // App owns settings so they actually apply: fontSize flows to every terminal
  // (reactive prop below), vibrate/layout flow to the keyboard.
  function applySettings(next: Settings) {
    settings = next;
    saveSettings(next);
    applyTheme(next.theme);
    applyLanguage(next.language);
  }

  function openPanel(p: BottomPanel) {
    bottomPanel = p;
    fullscreen = false; // leaving fullscreen — otherwise the bottom region stays hidden
    // 需求9: entering the file panel re-syncs the root to the terminal's pwd
    // if root-follow is on and the focused tab is a terminal that has cd'd.
    if (p !== "file" || !loadRootFollow()) return;
    if (!activeTopId || activeTopId.startsWith("file:")) return;
    void getFocusedPwd().then((r) => {
      if (!("pwd" in r)) return;
      const next = shouldSyncRoot({ panel: "file", follow: true, activeTopId, pwd: r.pwd, currentRoot: loadProjectRoot() });
      if (next) { saveProjectRoot(next); pushRootHistory(next); rootTick++; }
    });
  }
  // Persistent pubkey reminder stays reactive to the locale (uses $t inside
  // $derived); transient notices (resync/error) go through `flash`.
  let flash = $state("");
  const notice = $derived(!getAgentPubKey() ? $t("app.notice.noPubkey") : flash);

  const conn = new Connection({ url: wsUrl });
  let status = $state<ConnStatus>("connecting");
  let updInfo = $state<CheckResult | null>(null);
  let updOpen = $state(false);
  let updPhase = $state<string | null>(null);
  let updPct = $state<number | null>(null);
  let updMsg = $state<string | null>(null);
  async function refreshUpdate(force = false) {
    try { updInfo = (await conn.checkUpdate(force)) as CheckResult; } catch { /* silent */ }
  }
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
    // req 7-2: a line starting with '/' means the user is composing a
    // CC/Codex slash command → suggest from the built-in slash catalog instead
    // of shell history/catalog. delta()/onHint reuse unchanged.
    hints = s && s.trusted
      ? (s.line.startsWith("/") ? suggestSlash(s.line) : suggest(s.line, s.history, CATALOG))
      : [];
  }

  // Notification feature: tell the agent whether this device is looking at a
  // session right now, so it knows when to skip the system push (foreground +
  // same session = the user already sees the output, a push would be noise).
  const NOTIFY_VIBE: Record<Settings["vibrate"], number[]> = { off: [], light: [12], medium: [20], strong: [16, 8, 24] };
  function reportPresence() {
    conn.sendPresence(document.visibilityState === "visible", activeId || null);
  }
  conn.onStatus((s) => {
    const wasOnline = status === "online";
    status = s;
    if (s === "online" && !wasOnline) {
      reportPresence();
      // Fresh connect (incl. reconnect after a self-restart update): re-check.
      // If we were mid-update and the reconnect shows we're now current, the
      // restart finished successfully — clear the in-progress UI + badge and
      // let the user know.
      void refreshUpdate().then(() => {
        if (updPhase && updInfo && !updInfo.hasUpdate) {
          showToast(tr("update.done", { version: updInfo.current }));
          updOpen = false;
          updPhase = null;
        } else if (updPhase && updInfo?.hasUpdate) {
          // Update was in flight but didn't take effect (e.g. new binary failed
          // to boot and the supervisor fell back to the old one). Clear the
          // in-progress state so the dialog becomes dismissable again instead
          // of trapping the user in a perpetual progress modal.
          updPhase = null;
          updPct = null;
          updMsg = null;
        }
      });
    }
  });
  conn.onUpdate((u) => {
    updPhase = u.phase;
    updPct = u.pct ?? null;
    updMsg = u.message ?? null;
  });
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
    // R5: only assign when the order actually shrank — filter() always returns
    // a fresh array, which would retrigger the persist $effect + tab strip on
    // every ~3s broadcast even when nothing changed. Same length ⇒ identical.
    const keptOrder = tabOrder.filter((id) => id.startsWith("file:") || alive.has(id));
    if (keptOrder.length !== tabOrder.length) tabOrder = keptOrder;
    if (activeId && !alive.has(activeId)) activeId = "";
    if (!activeId) activeId = sessions.find((s) => s.attached && !s.closed)?.name ?? "";
  });
  conn.onExit((f) => { sessions = tombstone(sessions, f.sessionId); });
  conn.onResync(() => {
    flash = tr("app.notice.historyLost");
    setTimeout(() => (flash = ""), 4000);
  });
  conn.onError((f) => {
    flash = `${f.code}: ${f.message}`;
    setTimeout(() => (flash = ""), 4000);
  });
  // In-app hint for a background/other-session notification. The agent already
  // decided a system push wasn't needed (foreground + same session), so this
  // path only fires for the "you'd otherwise miss it" cases — mirror that same
  // rule here for the in-app toast.
  conn.onNotification((m) => {
    if (document.visibilityState === "visible" && activeId === m.sessionId) return;
    showToast(m.title, { detail: m.body });
    const p = NOTIFY_VIBE[settings.vibrate];
    if (p.length) navigator.vibrate?.(p);
  });
  conn.listSessions();

  // Re-apply when the OS scheme flips while preference is "system".
  const unwatchSystem = watchSystem(() => settings.theme, () => applyTheme(settings.theme));

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

    // Notification deep link, cold-start path: the SW's notificationclick opens
    // "/?session=<id>" when no window was already open — pick it up on first paint.
    const deepLinkSession = sessionFromUrl(location.search);
    if (deepLinkSession) enterSession(deepLinkSession);

    const onVisibility = () => reportPresence();
    document.addEventListener("visibilitychange", onVisibility);

    // Notification deep link, warm path: the SW forwards the tapped
    // notification's URL via postMessage instead of a navigation when a window
    // was already open (see public/sw.js notificationclick).
    const onSwMessage = (e: MessageEvent) => {
      if (e.data?.type !== "notification-nav") return;
      const sid = new URLSearchParams(new URL(e.data.url, location.origin).search).get("session");
      if (sid) enterSession(sid);
    };
    navigator.serviceWorker?.addEventListener("message", onSwMessage);

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
      document.removeEventListener("visibilitychange", onVisibility);
      navigator.serviceWorker?.removeEventListener("message", onSwMessage);
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
      return { kind: "file" as const, id, title: f.title, path: f.path };
    }
    const s = sessions.find((x) => x.name === id);
    return { kind: "term" as const, id, title: id, state: s?.state ?? "idle", closed: s?.closed ?? false, shell: s?.kind === "shell" };
  }));

  function newSession(name: string, kind: "tmux" | "shell" = "tmux") {
    conn.newSession(name, { kind });
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
    void navigator.clipboard?.writeText(text.replace(/\n+$/, "\n")).then(() => showToast(tr("app.toast.copiedVisible")));
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

  async function handleNewFile(dir: string, name: string): Promise<boolean> {
    const path = dir === "/" ? "/" + name : dir + "/" + name;
    try {
      await conn.rpc("fs.op", { op: "touch", path });
    } catch (e: any) {
      showToast(tr("app.toast.newFileFailed") + ": " + (e?.message ?? ""));
      return false;
    }
    treeTick++;
    pendingEdit = path;      // FilePreview auto-enters the editor once loaded
    openFile(path, "code");
    return true;
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
    setFileDirty(id, false);
    if (editingId === id) { editingId = null; fullscreen = false; }
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
    const s = sessions.find((x) => x.name === id);
    if (s?.kind === "shell") {
      // Shell tabs are ephemeral: closing the tab kills the PTY outright.
      conn.kill(id);
      sessions = closeTabFn(sessions, id);
      terms.delete(id);
      tabOrder = removeOrder(tabOrder, id);
      if (activeId === id) activeId = topSessions.filter((x) => x.name !== id)[0]?.name ?? "";
      if (activeTop === id) activeTop = "";
      return;
    }
    conn.detach(id); // backgrounded term tabs stop their output stream, same as toBackground
    backgrounded.add(id);
    backgrounded = new Set(backgrounded);
    tabOrder = removeOrder(tabOrder, id);
    if (activeId === id) activeId = topSessions.filter((s) => s.name !== id)[0]?.name ?? "";
    if (activeTop === id) activeTop = "";
  }
  function selectTop(id: string) {
    cancelSelection();
    copyMode = false; // leaving the tab drops the copy-mode overlay (clone is stale)
    if (id.startsWith("file:")) { activeTop = id; }
    else { activeTop = ""; selectSession(id); }
    // An open editor forces fullscreen; leaving its tab must release it (the
    // divider — the usual exit — is hidden while fullscreen). Only touch
    // fullscreen when an editor is actually open, so manual terminal-fullscreen
    // is unaffected.
    if (editingId) fullscreen = id === editingId;
  }

  // Read the focused tab's real cwd for the file panel's root buttons.
  async function getFocusedPwd(): Promise<{ pwd: string } | { error: string }> {
    if (!activeTopId || activeTopId.startsWith("file:")) return { error: tr("app.error.notTerminal") };
    try {
      const r = (await conn.rpc("terminal.pwd", { session: activeTopId })) as { pwd: string };
      if (!r.pwd) return { error: tr("app.error.pwdFailed") };
      return { pwd: r.pwd };
    } catch {
      return { error: tr("app.error.pwdFailed") };
    }
  }

  // Recompute hint bar when the active terminal changes; also re-report
  // presence so the agent knows which session (if any) is now on screen.
  $effect(() => {
    activeId;
    recomputeHints();
    reportPresence();
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
    copyMode = false;
    conn.detach(activeId); // R2: unsubscribe; reopening re-attaches via Terminal mount
    backgrounded.add(activeId);
    backgrounded = new Set(backgrounded);
    activeId = topSessions[0]?.name ?? "";
  }

  function activeTerm() { return terms.get(activeId); }

  function cancelSelection() {
    if (sel.mode === "idle") return;
    activeTerm()?.clearSelection();
    sel = reset();
    selCount = 0;
  }

  function writeClip(text: string, ok: string) {
    const p = navigator.clipboard?.writeText?.(text);
    if (p) p.then(() => showToast(ok)).catch(() => showToast(tr("app.toast.clipboardDenied")));
    else showToast(tr("app.toast.clipboardDenied"));
  }

  function copyTabPath(id: string) {
    const path = filePathFromTabId(fileTabs, id);
    if (!path) return;
    const p = navigator.clipboard?.writeText?.(path);
    if (p) p.then(() => showToast(tr("app.toast.copiedPath"), { detail: path }))
           .catch(() => showToast(tr("app.toast.clipboardDenied")));
    else showToast(tr("app.toast.clipboardDenied"));
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
      case "toggleFullscreen": cancelSelection(); copyMode = false; fullscreen = !fullscreen; break;
      case "copyVisible": {
        const t = activeTerm(); if (!t) { showToast(tr("app.toast.noTerminal")); break; }
        const text = lastOutput(t.buffer.active, t.rows);
        if (!text.trim()) { showToast(tr("app.toast.noOutput")); break; }
        writeClip(text, tr("app.toast.copiedOutput"));
        break;
      }
      case "renameSession": {
        const next = prompt(tr("app.prompt.rename"), activeId);
        if (next && next.trim() && next !== activeId) renameSession(activeId, next.trim());
        break;
      }
      case "copyMode": {
        // req 7-5: open the copy-mode overlay over the active terminal so a
        // mobile long-press can select static text natively. File tabs have no
        // terminal to clone.
        if (activeTopId.startsWith("file:")) { showToast(tr("app.toast.noTerminal")); break; }
        const t = activeTerm(); if (!t) { showToast(tr("app.toast.noTerminal")); break; }
        cancelSelection();
        copyMode = true;
        break;
      }
      case "selectAllCopy": {
        const t = activeTerm(); if (!t) break;
        t.selectAll();
        writeClip(t.getSelection(), tr("app.toast.copiedAll"));
        t.clearSelection();
        sel = reset();
        selCount = 0;
        break;
      }
      case "paste": {
        if (!activeId) break;
        const rd = navigator.clipboard?.readText?.();
        if (rd) rd.then((text) => { if (text) conn.sendInput(activeId, new TextEncoder().encode(text)); })
                 .catch(() => showToast(tr("app.toast.clipboardDenied")));
        else showToast(tr("app.toast.clipboardDenied"));
        break;
      }
      case "togglePageFullscreen": togglePageFullscreen(); break;
      case "clearScreen": if (activeId) sendActive("\x0c"); break;
      case "smartCopy": {
        // Phase 5 req 1+2: system native selection -> keyboard selection -> last output.
        const sys = window.getSelection?.()?.toString() ?? "";
        if (sys.trim()) { writeClip(sys, tr("app.toast.copiedText")); break; }
        const t = activeTerm(); if (!t) { showToast(tr("app.toast.noTerminal")); break; }
        const kb = t.getSelection();
        if (kb) { writeClip(kb, tr("app.toast.copiedSelection")); cancelSelection(); break; }
        const text = lastOutput(t.buffer.active, t.rows);
        if (!text.trim()) { showToast(tr("app.toast.noOutput")); break; }
        writeClip(text, tr("app.toast.copiedOutput"));
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
  let toastDetail = $state("");
  let toastVisible = $state(false);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(text: string, opt: { detail?: string; ms?: number } = {}) {
    toastText = text;
    toastDetail = opt.detail ?? "";
    toastVisible = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastVisible = false), opt.ms ?? 1800);
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
</script>

<div class="shell">
  <div class="topbar">
    <span class="brand mono">◧ Pocket<b>Shell</b></span>
    <span class="version mono">v{updInfo?.current ?? ""}</span>
    {#if updInfo?.hasUpdate}
      <button class="upd-badge" onclick={() => (updOpen = true)} aria-label={$t('update.badge')} title={$t('update.badge')}><span class="upd-dot">●</span>{$t('update.badge')}</button>
    {/if}
    <div class="conn conn-{status}">
      <span class="conn-dot"></span>
      <span class="conn-text mono">{$t('app.status.' + status)}</span>
    </div>
    <button class="fs-btn" aria-label={pageFullscreen ? $t('app.fullscreen.exit') : $t('app.fullscreen.enter')} onclick={togglePageFullscreen}>
      {#if pageFullscreen}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
      {/if}
    </button>
  </div>

  <div class="tabs-wrap">
    <TopTabs tabs={topTabsView} activeId={activeTopId} onSelect={selectTop} onNew={newSession} onCloseTab={closeTopTab} onCopyPath={copyTabPath} dirtyIds={fileDirty} />
  </div>

  {#if notice}<div class="notice">{notice}</div>{/if}
  {#if status !== "online"}
    <div class="banner">{$t('app.banner')}</div>
  {/if}

  <div class="top" style="flex: {topFlex} 1 0;" role="application" aria-label={$t('app.topAria')} bind:this={topEl}>
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
      <FilePreview {conn} path={t.path} mode={t.mode} active={activeTopId === t.id}
        base={(rootTick, loadProjectRoot())}
        onToast={showToast}
        onEditingChange={(e) => {
          editingId = e ? t.id : (editingId === t.id ? null : editingId);
          if (activeTopId === t.id) fullscreen = e;
        }}
        onDirtyChange={(d) => setFileDirty(t.id, d)}
        autoEdit={pendingEdit === t.path && t.mode === "code"}
        onAutoEdit={() => (pendingEdit = null)} />
    {/each}
    {#if topSessions.length === 0 && fileTabs.length === 0}
      <div class="hint">
        <div class="hint-title">{$t('app.empty.title')}</div>
        <div class="hint-body">{$t('app.empty.body')}</div>
      </div>
    {/if}
    {#if copyMode}
      <TermCopyOverlay term={activeTerm()}
        onClose={() => (copyMode = false)}
        onCopy={(text) => {
          if (text.trim()) { writeClip(text, tr("app.toast.copiedSelection")); copyMode = false; }
          else showToast(tr("app.toast.noSelection"));
        }} />
    {/if}
  </div>

  <div class="divider" class:hidden={fullscreen} role="separator" onpointerdown={onDividerDown} onpointermove={onDividerMove} onpointerup={onDividerUp}>
    <div class="grip"></div>
  </div>
  <div class="bottom" class:hidden={fullscreen} style="flex: {1 - topFlex} 1 0;">
    <div class="panel-slot" class:hidden={bottomPanel !== "file"}>
      <FilePanel {conn} onOpenFile={(p) => openFile(p, "code")} onOpenDiff={(p) => openFile(p, "diff")} onCd={(p) => sendActive('cd ' + JSON.stringify(p) + '\n')} {getFocusedPwd} {rootTick} {treeTick} onToast={showToast} onToastRich={(title, detail, ms) => showToast(title, { detail, ms })} onNewFile={handleNewFile} />
    </div>
    <div class="panel-slot" class:hidden={bottomPanel !== "task"}>
      <TaskPanel
        sessions={sessions.filter((s) => s.kind !== "shell")}
        onSelect={enterSession}
        onRename={renameSession}
        onKill={killSession}
        onCopy={copyOutput}
        onClose={closeTab}
      />
    </div>
    <div class="panel-slot" class:hidden={bottomPanel !== "set"}>
      <SettingsPanel {conn} {settings} onChange={applySettings}
        currentVersion={updInfo?.current ?? ""}
        onCheckUpdate={async () => {
          await refreshUpdate(true);
          if (updInfo?.hasUpdate) updOpen = true;
          else showToast(tr("update.upToDate"));
        }} />
    </div>
    <div class="panel-slot" class:hidden={bottomPanel !== "kbd"}>
      <Keyboard onText={sendActive} onCommand={runCommand} vibrate={settings.vibrate} layout={settings.layout} {hints} {onHint} />
    </div>
    <div class="panel-slot" class:hidden={bottomPanel !== "snip"}>
      <SnippetPanel {conn} onInsert={sendActive} />
    </div>
  </div>

  <BottomBar active={bottomPanel} taskBadge={sessions.some((s) => s.state === "wait")} onSelect={openPanel} />
</div>

{#if toastVisible}
  <div class="toast" class:visible={toastVisible} class:has-detail={toastDetail}>
    <div class="toast-title">{toastText}</div>
    {#if toastDetail}<div class="toast-detail mono">{toastDetail}</div>{/if}
  </div>
{/if}

{#if updOpen && updInfo}
  <UpdateDialog info={updInfo} phase={updPhase} pct={updPct} message={updMsg}
    onCancel={() => { if (!updPhase) updOpen = false; }}
    onConfirm={async () => {
      if (updPhase === "error") updPhase = null;
      updPhase = "downloading";
      const r = (await conn.applyUpdate()) as { started: boolean; reason?: string };
      if (!r.started) { updPhase = "error"; updMsg = r.reason ?? "failed"; }
    }} />
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
    padding: 10px 14px 8px;
    background: var(--bg);
    flex: 0 0 auto;
  }
  .brand {
    font-weight: 700;
    letter-spacing: 0.2px;
    font-size: 0.94rem;
    color: var(--text);
  }
  .brand b { color: var(--accent); font-weight: 700; }
  .version {
    font-size: 0.62rem;
    color: var(--dimmer);
    font-weight: 600;
    margin-top: 2px;
  }
  .upd-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--accent);
    background: transparent;
    border: 1px solid var(--accent);
    border-radius: 999px;
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
    padding: 2px 8px;
  }
  /* Keep the attention-drawing pulse on the dot only, so the "有新版本" text
     stays steady and readable (req: the bare dot was too subtle). */
  .upd-badge .upd-dot {
    font-size: 12px;
    animation: upd-pulse 2s infinite;
  }
  @keyframes upd-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  @media (prefers-reduced-motion: reduce) {
    .upd-badge .upd-dot { animation: none; }
  }
  .conn {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.68rem;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--dim);
  }
  .conn-online { color: var(--ok); background: var(--ok-soft); border-color: var(--ok-line); }
  .conn-connecting { color: var(--amber); background: var(--amber-soft); border-color: var(--amber); }
  .conn-offline { color: var(--red); background: var(--red-soft); border-color: var(--red); }
  .conn-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .conn-online .conn-dot { box-shadow: 0 0 6px currentColor; }
  .conn-text {
    min-width: 3em;
    text-align: right;
  }
  .fs-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: var(--radius-md);
    color: var(--dim);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }
  .fs-btn svg { width: 16px; height: 16px; display: block; }
  .fs-btn:hover { color: var(--text); }
  .fs-btn:active { background: var(--keyhi); }

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
    background: var(--banner-bg);
    color: var(--banner-text);
    font-size: 0.72rem;
    padding: 6px 12px;
    border-bottom: 1px solid var(--banner-line);
    text-align: center;
    flex: 0 0 auto;
  }
  .notice {
    background: var(--banner-bg);
    color: var(--red);
    padding: 8px 12px;
    font-size: 13px;
    border-bottom: 1px solid var(--banner-line);
    flex: 0 0 auto;
  }

  .top {
    position: relative;
    min-height: 0;
    overflow: hidden;
    background: var(--term-bg);
    border: 1px solid var(--line-soft);
    border-radius: var(--radius-lg);
    margin: 0 8px;
  }
  .hint {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--term-dim);
    text-align: center;
    gap: 6px;
  }
  .hint-title { font-size: 15px; color: var(--term-text); }
  .hint-body { font-size: 12px; }

  .divider {
    flex: 0 0 auto;
    background: transparent;
    padding: 7px 0;
    touch-action: none;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .grip {
    width: 40px;
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
  .panel-slot {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .divider.hidden, .bottom.hidden, .panel-slot.hidden { display: none; }

  .toast {
    position: absolute;
    left: 50%;
    bottom: 110px;
    transform: translateX(-50%) translateY(8px);
    background: var(--toast-bg);
    border: 1px solid var(--line-strong);
    color: var(--toast-text);
    font-size: 0.72rem;
    padding: 8px 14px;
    border-radius: 999px;
    box-shadow: var(--pop-shadow);
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
  .toast.has-detail { white-space: normal; max-width: min(78vw, 320px); text-align: center; border-radius: var(--radius-lg); }
  .toast-detail { font-size: 0.66rem; color: var(--dim); margin-top: 4px; word-break: break-all; line-height: 1.5; }
</style>
