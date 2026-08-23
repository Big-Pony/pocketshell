<script lang="ts">
  import type { Terminal } from "@xterm/xterm";
  import { onMount } from "svelte";
  import { Connection, type ConnStatus } from "./lib/net/connection";
  import { registerDevHelpers, unregisterDevHelpers } from "./lib/dev-helpers";
  import { mergeSessions, tombstone, closeTab as closeTabFn, nextSessionName, shouldAdopt, type LocalSession } from "./lib/ui/session-view";
  import { clampSplit, type BottomPanel } from "./lib/ui/shell";
  import { recallDims } from "./lib/term/fit-guard";
  import TerminalView from "./components/Terminal.svelte";
  import TermCopyOverlay from "./components/TermCopyOverlay.svelte";
  import TopTabs from "./components/TopTabs.svelte";
  import TaskPanel from "./components/TaskPanel.svelte";
  import FilePanel from "./components/FilePanel.svelte";
  import FilePreview from "./components/FilePreview.svelte";
  import BottomBar from "./components/BottomBar.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import type { LinkMetrics } from "./lib/net/connection";
  import { openOrReuseFileTab, closeFileTab, filePathFromTabId, replaceTabPath, cycle, stepClamp, appendOrder, removeOrder, visibleOrder, groupByKind, backgroundTab, type TopTab } from "./lib/ui/top-tabs";
  import DeviceManager from "./components/DeviceManager.svelte";
  import Keyboard from "./components/Keyboard.svelte";
  import SnippetPanel from "./components/SnippetPanel.svelte";
  import SettingsPanel from "./components/SettingsPanel.svelte";
  import UpdateDialog from "./components/UpdateDialog.svelte";
  import KeyboardTutorial from "./components/KeyboardTutorial.svelte";
  import { shouldShowTutorial, markTutorialSeen, tutorialFor, type TutorialId } from "./lib/term/kb-tutorial";
  import type { CheckResult } from "./lib/update";
  import { shouldReloadAfterUpdate } from "./lib/update";
  import { hardReset } from "./lib/cache-admin";
  import { brandPrefix } from "./lib/ui/instance-name";
  import { inputTarget } from "./lib/ui/input-target";
  import type { AppCommand } from "./lib/term/input-router";
  import { reset, type SelState } from "./lib/term/terminal-select";
  import { makeSwipeTracker } from "./lib/ui/swipe";
  import { loadSettings, saveSettings, type Settings } from "./lib/settings";
  import { applyTheme, watchSystem } from "./lib/theme";
  import { loadTabs, saveTabs } from "./lib/ui/tab-store";
  import { getAgentPubKey, getAgentAddr } from "./lib/net/keystore";
  import { loadProjectRoot, saveProjectRoot, pushRootHistory, loadRootFollow, saveRootFollow } from "./lib/ui/file-tree";
  import { shouldSyncRoot } from "./lib/ui/root-follow";
  import { defaultAgentUrl } from "./lib/net/agent-url";
  import { sessionFromUrl, shouldSyncPush } from "./lib/notify";
  import { syncSubscription } from "./lib/web-push-client";
  import { lastOutput, PROMPT_RE } from "./lib/term/terminal-output";
  import { OutputAnchors, rowsBack, trimTrailingPrompt } from "./lib/term/output-anchor";
  import type { TermCaptureResult } from "./lib/net/protocol";
  import { fromB64 } from "./lib/bytes";
  import { fullscreenAction } from "./lib/ui/fullscreen";
  import { emptyCmdLine, feed, type CmdLineState } from "./lib/command-line";
  import { suggest, delta } from "./lib/command-suggest";
  import { suggestSlash } from "./lib/slash-catalog";
  import { splitPools } from "./lib/hints";
  import { CATALOG } from "./lib/command-catalog";
  import { t } from "svelte-i18n";
  import { applyLanguage, tr } from "./lib/i18n";
  import { createDemoConnection } from "./demo";

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

  // 切到 layered / flick 且没看过时弹一次教程。判定放在 applySettings 里
  // 而不是 $effect：后者在 settings 对象每次重建时都会重放，教程会反复弹；
  // 这里能拿到「改之前」的值，是真正的「切换发生了」这一刻。
  let kbTutorial = $state<TutorialId | null>(null);
  function closeKbTutorial() {
    if (kbTutorial) markTutorialSeen(kbTutorial);
    kbTutorial = null;
  }

  // App owns settings so they actually apply: fontSize flows to every terminal
  // (reactive prop below), vibrate/layout flow to the keyboard.
  function applySettings(next: Settings) {
    const kbChanged = next.kbLayout !== settings.kbLayout;
    settings = next;
    saveSettings(next);
    applyTheme(next.theme);
    applyLanguage(next.language);
    if (kbChanged && shouldShowTutorial(next.kbLayout)) kbTutorial = tutorialFor(next.kbLayout);
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

  // 演示构建：整个传输层换成同页面内的假 agent。这个比较是编译期常量，
  // 真实构建里 vite 会把演示分支连同 src/demo/** 整个剪掉。
  const DEMO = import.meta.env.VITE_POCKETSHELL_DEMO === "1";

  // 演示态没有（也不需要）Agent 公钥：连接是同页面内的假 agent，本来就通。
  // 不门控的话演示站首屏永远顶着一条红字，还把访客指向一个已被禁用的入口。
  const notice = $derived(!DEMO && !getAgentPubKey() ? $t("app.notice.noPubkey") : flash);
  const demo = DEMO ? createDemoConnection(wsUrl) : null;
  const conn = demo ? demo.conn : new Connection({ url: wsUrl });
  let status = $state<ConnStatus>("connecting");
  // 首次连接与断线重连是两回事：前者没什么"断开"可言，用同一句"已断开"
  // 会让第一次打开 App 的人以为出了问题（14 期需求 5）。
  let everOnline = $state(false);
  let updInfo = $state<CheckResult | null>(null);
  let updOpen = $state(false);
  let updPhase = $state<string | null>(null);
  let updPct = $state<number | null>(null);
  let updMsg = $state<string | null>(null);
  async function refreshUpdate(force = false) {
    try { updInfo = (await conn.checkUpdate(force)) as CheckResult; } catch { /* silent */ }
  }
  // 实例身份：服务端配置的自由文本，连上后取一次显示在顶栏。未设时为 null，
  // brandPrefix 返回空串 —— 顶栏与加此特性前完全一致。
  let instanceName = $state<string | null>(null);
  async function loadAgentInfo() {
    try { instanceName = (await conn.agentInfo()).instanceName; }
    catch { /* 断线时保持现状，不清空已显示的名字 */ }
  }
  const terms = new Map<string, Terminal>();
  // 每个终端暴露的重灌入口（onResync 用）。与 terms 同生命周期。
  const reseeders = new Map<string, (t: "alt-normal" | "stash-dirty" | "resync") => void>();
  const cmdLines = new Map<string, CmdLineState>();
  let hints = $state<string[]>([]);
  // 需求 5：用户自定义联想库。hintsChanged 广播无载荷，收到后重拉全量。
  let customHints = $state<{ shell: string[]; slash: string[] }>({ shell: [], slash: [] });
  async function reloadCustomHints() {
    try { customHints = splitPools((await conn.listHints()).items.map((h) => h.text)); }
    catch { /* 断线时保持现状 */ }
  }
  conn.onHintsChanged(() => { void reloadCustomHints(); });

  // ---- 分割条数据 ----
  // 链路指标由 connection 每个心跳周期结算一次推过来（复用心跳定时器，无新开销）。
  let metrics = $state<LinkMetrics>({ latency: null, rxBytes: 0, txBytes: 0, elapsedMs: 0 });
  conn.onMetrics((m) => { metrics = m; });

  // Git 分支提到 App 层，与文件面板共享同一次 git.branches 结果——分割条不新增
  // 轮询。切根（rootTick）与文件面板刷新（treeTick）时跟着更新。
  let gitBranch = $state("");
  let gitDirty = $state(false);
  // 切根 / 目录树刷新时跟着更新（这两个 tick 本就代表「项目根或工作区变了」）。
  $effect(() => { rootTick; treeTick; void refreshGitBranch(); });
  async function refreshGitBranch() {
    if (status !== "online") return;
    const cwd = loadProjectRoot();
    try {
      const b = (await conn.rpc("git.branches", { cwd })) as { current?: string };
      gitBranch = b?.current ?? "";
    } catch {
      gitBranch = "";   // 非 git 仓库 / 未设项目根 → 左侧整块隐藏
      gitDirty = false;
      return;
    }
    try {
      const s = (await conn.rpc("git.status", { cwd })) as { files?: unknown[] };
      gitDirty = (s?.files?.length ?? 0) > 0;
    } catch {
      gitDirty = false;
    }
  }

  function cmdState(id: string): CmdLineState {
    let s = cmdLines.get(id);
    if (!s) { s = emptyCmdLine(); cmdLines.set(id, s); }
    return s;
  }
  function recomputeHints() {
    const s = cmdLines.get(activeId);
    // req 7-2: a line starting with '/' means the user is composing a
    // CC/Codex slash command → suggest from the slash catalog instead of
    // shell history/catalog. 需求 5：两条链路各自先拼用户自定义池。
    hints = s && s.trusted
      ? (s.line.startsWith("/")
          ? suggestSlash(s.line, customHints.slash)
          : suggest(s.line, s.history, customHints.shell, CATALOG))
      : [];
  }

  // Notification feature: tell the agent whether this device is looking at a
  // session right now, so it knows when to skip the system push (foreground +
  // same session = the user already sees the output, a push would be noise).
  const NOTIFY_VIBE: Record<Settings["vibrate"], number[]> = { off: [], light: [12], medium: [20], strong: [16, 8, 24] };
  function reportPresence() {
    conn.sendPresence(document.visibilityState === "visible", activeId || null);
  }

  // 14 期需求 4：每次连上无条件对齐一次订阅。
  //
  // 此前是"判断要不要重新订阅"（needsResubscribe），而判据（浏览器有没有
  // 订阅）信息量不足以发现 endpoint 分叉——生产实证：设备天天连，agent 侧
  // push-subs.json 一个月没更新过，而 FCM 对那条已轮换的旧 endpoint 仍返回
  // 201，两边都以为一切正常。现在不问「要不要」，直接把当前订阅报过去，
  // agent 按设备公钥幂等 upsert。
  //
  // 静默是刻意的：这不是用户发起的操作，成功了不该打扰，失败了（比如连不上
  // FCM）也不该在刚进门时弹一条看不懂的报错——用户真去开关时 SettingsPanel
  // 会把原因讲清楚。
  //
  // 判据见 shouldSyncPush：要求本机通知权限已是 granted，所以既不会替一台
  // 从没开过推送的设备订阅（notify.json 是 agent 全局的，新设备也读得到
  // webPush=true），也不会弹出权限框（权限为 default 时 subscribe() 会弹）。
  async function healWebPush() {
    try {
      if (typeof Notification === "undefined") return; // 不支持通知的浏览器
      const cfg = (await conn.notifyGetConfig()) as { webPush?: boolean };
      if (!shouldSyncPush({
        cfgWebPush: cfg?.webPush === true,
        permission: Notification.permission,
      })) return;
      await syncSubscription(conn);
    } catch {
      // 静默：见上。下次连上会再试一次。
    }
  }
  conn.onStatus((s) => {
    const wasOnline = status === "online";
    status = s;
    if (s === "online") everOnline = true;
    if (s === "online" && !wasOnline) {
      reportPresence();
      void refreshGitBranch();   // 重连后补一次，分割条左侧才不会一直空着
      void reloadCustomHints();  // 需求 5：连上/重连后拉一次自定义联想库
      void loadAgentInfo();      // 实例身份：顶栏要显示是哪台服务器
      void healWebPush();        // 每次连上无条件对齐一次推送订阅（14 期需求 4）
      // Fresh connect (incl. reconnect after a self-restart update): re-check.
      // If we were mid-update and the reconnect shows we're now current, the
      // restart finished successfully — clear the in-progress UI + badge and
      // let the user know.
      void refreshUpdate().then(() => {
        // The agent restarted onto a new version: this page is now the OLD
        // frontend talking to a NEW agent. Drop the version-named cache buckets
        // and reload so the two are back in lockstep (see lib/cache-admin.ts).
        // Cost: unsaved editor buffers are lost. Terminals are fine — tmux is
        // the real session and replay backfills the output on re-attach.
        if (shouldReloadAfterUpdate(__APP_VERSION__, updInfo?.current ?? "", updPhase)) {
          showToast(tr("update.reloading", { version: updInfo!.current }), { ms: 3000 });
          setTimeout(() => void hardReset(), 800); // let the toast be seen
          return;
        }
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
  // 【2026-08-19 删除「重进时预先 attach」】这里曾对每个存活标签页发一次
  // conn.attach(id)（不带 seq ⇒ lastSeq=0），本意是「恢复被还原的标签页」。
  // 它在真机上是首屏卡顿与多 tab 空白的主要燃料，原因有两层：
  //   1) lastSeq=0 让服务端整环回放 —— 单个会话实测 2384 帧 / 221406B，而这些
  //      字节紧接着就会被 seedFromHistory 的 tmux 快照覆盖，纯属白传；
  //   2) 更要命的是它**吞掉**真正该发的那次 attach：connection.ts 的
  //      `if (subscribed || ...) return` 位于 seen 覆盖之后，于是随后
  //      attach(h.seq, {seed:true}) 只改记账、不发帧（connection.test.ts 有
  //      配对断言锁住这两条）。结果是唯一上线的 attach 永远是 lastSeq=0。
  // 8 个 tab 各来一份 221KB ≈ 1.7MB，直接顶穿服务端 1MB 高水位触发背压丢帧。
  //
  // 不需要任何替代品：topSessions 里的每个会话都挂 TerminalView，其 onMount
  // 调 seedFromHistory，内部负责 attach（失败时退回 attach(0) 兜底）。差集
  // 只有「alive 但 attached=false」的外部空闲会话，它们只出现在任务面板、
  // 不挂 TerminalView，attach 来的字节本就无人消费。
  conn.onSessions((list) => {
    sessions = mergeSessions(sessions, list);
    // Drop dead sessions from the order + focus so the strip only shows sessions
    // the server still has.
    const alive = new Set(sessions.map((s) => s.name));
    // R5: only assign when the order actually shrank — filter() always returns
    // a fresh array, which would retrigger the persist $effect + tab strip on
    // every ~3s broadcast even when nothing changed. Same length ⇒ identical.
    const keptOrder = tabOrder.filter((id) => id.startsWith("file:") || alive.has(id));
    if (keptOrder.length !== tabOrder.length) tabOrder = keptOrder;
    if (activeId && !alive.has(activeId)) activeId = "";
    if (!activeId) activeId = sessions.find((s) => s.attached && !s.closed)?.name ?? "";
  });
  conn.onExit((f) => { sessions = tombstone(sessions, f.sessionId); });

  // 「复制输出」的起点锚：sendInput 是所有输入的唯一收口，所以发出带回车的
  // 那一刻记下该会话的缓冲行号，就是本轮输出的起点——不用再猜提示符长什么样。
  // 只对在 App 里敲的命令有效；用户直接在电脑上敲的那轮我们看不到，copyVisible
  // 会退回提示符正则。
  const anchors = new OutputAnchors();
  conn.onInput((sid, data) => {
    anchors.record(sid, data, terms.get(sid)?.buffer.active);
  });
  // resync 的语义是「你确定性地缺了一段字节」（服务端背压丢帧，或 replay 环形
  // 缓冲已把客户端要的 seq 淘汰掉）。此前这里只弹一句提示，缺的字节永远补不
  // 回来 —— 那正是「中间少几行、重开才恢复」的一个独立来源。
  //
  // 必须是重灌快照而不是 term.redraw：refresh-client 只推可见屏那 rows 行，
  // scrollback 一个字节都不推（实测），补不了洞。
  // seq 缺口 = 服务端发了、客户端没收到的帧。上报到 agent 日志，让「中间少
  // 几行」这类故障从靠现场围观变成复现即定位（缺号区间直接指向丢失位置）。
  // 不给用户任何提示：缺口后面通常紧跟 resync 自愈，弹提示只会制造噪音。
  // seq 跳号 ⇒ 服务端发了、客户端没收到，且能定位到具体区间。这是「内容中间
  // 少几行」故障的第一个分岔口：有缺口 ⇒ 数据链路；无缺口而屏幕仍缺内容 ⇒
  // 往 screen 对拍与 render 心跳看（见 Terminal.svelte 的 sampleChain）。
  //
  // 字段用 expected/got/missing 三个专名，不复用 lastSeq/frames/bytes ——
  // 那三个是 attach 埋点的语义（字节数/帧数），混用会让日志里同名字段含义
  // 随 kind 漂移，翻日志的人必须记住哪个 kind 配哪套解释。
  conn.onSeqGap((f) => {
    // 诊断默认关闭（2026-08-23）。typeof 判断是防御更早版本的连接对象没有这个
    // 方法——一个诊断判断不该把 onSeqGap 回调打断。
    if (typeof conn.hasFeature !== "function" || !conn.hasFeature("diag")) return;
    void conn.rpc("diag.report", {
      tag: f.sessionId, kind: "seqgap",
      expected: f.expected, got: f.got, missing: f.missing,
    }).catch(() => {});
  });
  conn.onResync((f) => {
    flash = tr("app.notice.historyLost");
    setTimeout(() => (flash = ""), 4000);
    reseeders.get(f.sessionId)?.("resync");
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
    let offDemoMsg: (() => void) | null = null;
    let offDemoInput: (() => void) | null = null;
    if (demo) {
      demo.director.armAutoPlay();
      // 展台页（桌面）经 postMessage 触发同一个入口。同源，故 origin 可校验。
      const onMsg = (e: MessageEvent) => {
        if (e.origin !== location.origin) return;
        const d = e.data as { source?: string; action?: string; lang?: string } | null;
        if (d?.source !== "pocketshell-demo") return;
        if (d.action === "drop") demo.director.playDropScene();
        // 展台页切语言：走 applySettings 这条既有通路，settings 才会被持久化，
        // 手机框内 Settings 面板的选中态也才跟得上。
        if (d.action === "lang" && (d.lang === "zh" || d.lang === "en")) {
          applySettings({ ...settings, language: d.lang });
        }
      };
      window.addEventListener("message", onMsg);
      // 任何输入立即停自动播放（设计文档 2.5）。
      //
      // conn.onInput 只覆盖「真的发出了输入」，而 xterm 是 display-only
      // （Terminal.svelte:439）——桌面访客点一下手机框、用物理键盘敲字，
      // 一个 sendInput 都不会产生，自动播放于是停不下来：访客明明在操作，
      // 断线那一幕仍会按点上演，看起来就是「自己一直在断」。
      // 故再挂一层真实交互信号：指针按下与按键，捕获阶段拿，谁先来算谁。
      const stop = () => demo.director.notifyUserInput();
      const offInput = conn.onInput(stop);
      const opts = { capture: true } as const;
      window.addEventListener("pointerdown", stop, opts);
      window.addEventListener("keydown", stop, opts);
      offDemoMsg = () => {
        window.removeEventListener("message", onMsg);
        window.removeEventListener("pointerdown", stop, opts);
        window.removeEventListener("keydown", stop, opts);
      };
      offDemoInput = offInput;
    }
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
      // SW 在 pushsubscriptionchange 里转发过来的新 endpoint（14 期需求 4）。
      // 直接走既有的已认证 RPC 上报，不需要新协议、更不需要让 SW 自己发 HTTP。
      if (e.data?.type === "push-subscription-changed") {
        void conn.notifySubscribe(e.data.subscription).catch(() => {});
        return;
      }
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
      newSession,
      enterSession,
      getSessions: () => sessions.map((s) => ({ name: s.name, state: s.state })),
      dropConnection: () => conn.dropConnection(),
    });
    topEl?.addEventListener("pointerdown", onTopPointerDown, { capture: true });
    topEl?.addEventListener("pointerup", onTopPointerUp, { capture: true });
    topEl?.addEventListener("pointercancel", onTopPointerCancelOrLeave, { capture: true });
    topEl?.addEventListener("pointerleave", onTopPointerCancelOrLeave, { capture: true });
    topEl?.addEventListener("pointermove", onTopPointerMove, { capture: true });
    // Panel swipe lives on the bottom tab BAR (barEl), not the content area:
    // content-area swipe was unreliable because scrollable panels stole it.
    barEl?.addEventListener("pointerdown", onBarPointerDown, { capture: true });
    barEl?.addEventListener("pointerup", onBarPointerUp, { capture: true });
    barEl?.addEventListener("pointercancel", onBarPointerCancelOrLeave, { capture: true });
    barEl?.addEventListener("pointerleave", onBarPointerCancelOrLeave, { capture: true });
    barEl?.addEventListener("pointermove", onBarPointerMove, { capture: true });
    barEl?.addEventListener("click", onBarClickCapture, { capture: true });
    return () => {
      unregisterDevHelpers();
      topEl?.removeEventListener("pointerdown", onTopPointerDown, { capture: true });
      topEl?.removeEventListener("pointerup", onTopPointerUp, { capture: true });
      topEl?.removeEventListener("pointercancel", onTopPointerCancelOrLeave, { capture: true });
      topEl?.removeEventListener("pointerleave", onTopPointerCancelOrLeave, { capture: true });
      topEl?.removeEventListener("pointermove", onTopPointerMove, { capture: true });
      barEl?.removeEventListener("pointerdown", onBarPointerDown, { capture: true });
      barEl?.removeEventListener("pointerup", onBarPointerUp, { capture: true });
      barEl?.removeEventListener("pointercancel", onBarPointerCancelOrLeave, { capture: true });
      barEl?.removeEventListener("pointerleave", onBarPointerCancelOrLeave, { capture: true });
      barEl?.removeEventListener("pointermove", onBarPointerMove, { capture: true });
      barEl?.removeEventListener("click", onBarClickCapture, { capture: true });
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("visibilitychange", onVisibility);
      navigator.serviceWorker?.removeEventListener("message", onSwMessage);
      offDemoMsg?.();
      offDemoInput?.();
    };
  });

  // Top-tab list = adopted/live sessions plus tombstones, excluding backgrounded
  // and foreign idle sessions (those only appear in the task panel).
  const topSessions = $derived(
    sessions.filter((s) => !backgrounded.has(s.name) && (s.attached || s.closed))
  );
  // 当前聚焦会话的元数据 —— 分割条的 token 显示跟着它走。
  const activeSessionMeta = $derived(sessions.find((s) => s.name === activeId));
  const topOrder = $derived.by(() => {
    const base = visibleOrder(
      tabOrder,
      new Set([...topSessions.map((s) => s.name), ...fileTabs.map((t) => t.id)]),
      topSessions.map((s) => s.name),
    );
    return settings.groupTabsByType
      ? groupByKind(base, new Set(fileTabs.map((t) => t.id)))
      : base;
  });
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
    // 兜底尺寸：让新会话一开始就按本机宽度排版，而不是先用 agent 默认的 80x24
    // 跑一段、再由 refit 纠正——纠正前打进历史的硬换行是回不来的。
    // 没有兜底（首次使用、隐私模式）时 recallDims 返回 null，行为与从前一致。
    const d = recallDims();
    conn.newSession(name, { kind, cols: d?.cols, rows: d?.rows });
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
    reseeders.delete(name);
    anchors.clear(name); // the xterm buffer it referenced is gone
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

  // 所有键盘/输入法/片段文本的唯一出口。
  //
  // 目标会话取自 **activeTopId（聚焦的那个 tab）**，不是 activeId：两者会分叉
  // ——切到文件 tab 时只设 activeTop、不动 activeId（selectTop / openFile /
  // closeFile 三处），于是文本会静默打进上一个终端（2026-08-09 真机 bug）。
  // 判定收敛在 inputTarget 里，那儿有单测钉着。
  function sendActive(text: string) {
    const target = inputTarget(activeTopId);
    if (!target) return; // 聚焦在文件 tab 上：这段输入不属于任何终端
    conn.sendInput(target, new TextEncoder().encode(text));
    // Mirror outbound bytes into the per-session command line, except while a
    // full-screen TUI (vim/htop) owns the alternate screen — then hints pause.
    // 查的是 target 的终端而不是 activeTerm()（后者读 activeId）——同一个分叉，
    // 查错了会把字节镜像进另一个会话的命令行、污染它的联想。
    const alt = terms.get(target)?.buffer.active.type === "alternate";
    if (!alt) {
      cmdLines.set(target, feed(cmdState(target), text));
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
    // 同 sendActive：命令行差量要按**聚焦的那个终端**算。用 activeId 会在
    // 文件 tab 聚焦时拿上一个终端的命令行，算出一段错的差量再发出去。
    const target = inputTarget(activeTopId);
    if (!target) return;
    const s = cmdState(target);
    sendActive(delta(s.line, cmd));
  }

  function openFile(path: string, mode: "code" | "diff" = "code") {
    const r = openOrReuseFileTab(fileTabs, path, mode);
    fileTabs = r.tabs;
    tabOrder = appendOrder(tabOrder, r.id);
    activeTop = r.id;
    if (fullscreen) fullscreen = false;
  }
  // Drawer navigation: swap the file shown by a preview tab in place, keeping the
  // tab id stable so its FilePreview instance (fullscreen + drawer) is preserved.
  function navigateFile(tabId: string, newPath: string) {
    fileTabs = replaceTabPath(fileTabs, tabId, newPath);
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
      reseeders.delete(id);
      anchors.clear(id);
      tabOrder = removeOrder(tabOrder, id);
      if (activeId === id) activeId = topSessions.filter((x) => x.name !== id)[0]?.name ?? "";
      if (activeTop === id) activeTop = "";
      return;
    }
    conn.detach(id); // backgrounded term tabs stop their output stream, same as toBackground
    ({ tabOrder, backgrounded } = backgroundTab(tabOrder, backgrounded, id));
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
    // 2026-08-18：此前这里**漏了** tabOrder 的移除（closeTopTab 有、这里没有），
    // 于是后台化会话永久留在 tabOrder → localStorage → 重进时被无条件 attach，
    // 而它根本不挂 TerminalView，字节无人消费纯粹抢带宽。两条路径现在共用
    // backgroundTab()，对称性是结构性的而不是靠人记住。
    ({ tabOrder, backgrounded } = backgroundTab(tabOrder, backgrounded, activeId));
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

  // 「复制输出」：优先走回车锚点向 tmux 要那一段纯文本。
  //
  // 为什么不再只靠 lastOutput()：它从光标往上找**长得像提示符**的行来切段，
  // 主题化提示符、多行提示符、或输出里恰好有个 `$ ` 都会切错。锚点是我们发出
  // 回车那一刻记下的真实行号，不用猜。
  //
  // 走 tmux 而不是前端 buffer 还有两个好处：不受 xterm scrollback 上限截断，
  // 且 `-J` 会把 tmux 折行还原成原始长行（前端 buffer 里它们已经被按当前宽度
  // 硬折过了，复制出来是断的）。
  //
  // 三层兜底，任何一层出问题都还能复制到东西：
  //   1. 有锚点 + tmux 返回非空 → 用它；
  //   2. 没锚点（用户直接在电脑上敲的那轮，前端看不见）或 tmux 空/失败
  //      → 退回原来的提示符正则 lastOutput()；
  //   3. 都空 → 明确提示无输出，不往剪贴板写空串。
  async function copyLastOutput(sessionId: string, term: Terminal) {
    const fallback = () => {
      const text = lastOutput(term.buffer.active, term.rows);
      if (!text.trim()) { showToast(tr("app.toast.noOutput")); return; }
      writeClip(text, tr("app.toast.copiedOutput"));
    };
    const anchor = anchors.get(sessionId);
    if (anchor === undefined) { fallback(); return; }
    try {
      const buf = term.buffer.active;
      const r = (await conn.rpc("term.capture", {
        session: sessionId,
        back: rowsBack(anchor, buf.baseY + buf.cursorY),
      })) as TermCaptureResult;
      const raw = r?.data ? new TextDecoder().decode(fromB64(r.data)) : "";
      const text = trimTrailingPrompt(raw, PROMPT_RE);
      if (!text.trim()) { fallback(); return; }
      writeClip(text, tr("app.toast.copiedOutput"));
    } catch {
      fallback(); // 断线/超时：本地 buffer 里还有东西可复制
    }
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
        void copyLastOutput(activeId, t);
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
        void copyLastOutput(activeId, t); // 与「复制输出」同一条锚点链路
        break;
      }
    }
  }

  // ---- Top-area swipe to switch tabs ----
  // Shared stateful tracker (makeSwipeTracker). Beyond down/up it evaluates a
  // pointercancel from its last-known move: xterm's viewport / a scrollable
  // preview may claim the touch and the browser fires `pointercancel` instead of
  // `pointerup`, which would otherwise drop the gesture.
  const topSwipe = makeSwipeTracker((dir) => {
    const next = stepClamp(topOrder, activeTopId, dir === "left" ? 1 : -1); // left -> next tab
    if (next && next !== activeTopId) selectTop(next);
  });
  const onTopPointerDown = (e: PointerEvent) => topSwipe.down(e);
  const onTopPointerMove = (e: PointerEvent) => topSwipe.move(e);
  const onTopPointerUp = (e: PointerEvent) => topSwipe.up(e);
  const onTopPointerCancelOrLeave = () => topSwipe.cancel();

  // ---- Bottom tab-BAR swipe to switch panels ----
  // Swiping the content AREA proved unreliable (scrollable panels stole the
  // gesture), so the swipe lives on the bottom tab bar itself. A detected swipe
  // also suppresses the button click under the release point, so a swipe that
  // ends over a neighbouring tab does not ALSO select it (double jump).
  let barEl: HTMLDivElement | null = null;
  let barSwiped = false;
  const BOTTOM_PANELS: BottomPanel[] = ["task", "file", "kbd", "snip", "set"];
  const bottomSwipe = makeSwipeTracker((dir) => {
    barSwiped = true; // a real swipe (not a tap) — swallow the ensuing click
    const next = stepClamp(BOTTOM_PANELS, bottomPanel, dir === "left" ? 1 : -1);
    if (next && next !== bottomPanel) openPanel(next);
  });
  const onBarPointerDown = (e: PointerEvent) => { barSwiped = false; bottomSwipe.down(e); };
  const onBarPointerMove = (e: PointerEvent) => bottomSwipe.move(e);
  const onBarPointerUp = (e: PointerEvent) => bottomSwipe.up(e);
  const onBarPointerCancelOrLeave = () => bottomSwipe.cancel();
  // Capture-phase: runs before the tab button's onclick, so a swipe cancels it.
  const onBarClickCapture = (e: MouseEvent) => { if (barSwiped) { barSwiped = false; e.stopPropagation(); e.preventDefault(); } };

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
    <span class="brand mono" title={instanceName ? $t('app.instanceName', { values: { name: instanceName } }) : undefined}>{brandPrefix(instanceName)}pocket<b>shell</b></span>
    <span class="version mono">v{updInfo?.current ?? ""}</span>
    {#if updInfo?.hasUpdate}
      <button class="upd-badge" onclick={() => (updOpen = true)} aria-label={$t('update.badge')} title={$t('update.badge')}><span class="upd-dot">●</span>{$t('update.badge')}</button>
    {/if}
    <!-- 连接状态收成纯色点：文字信息由分割条的延迟数字承担。色点本身不带
         文字，所以 aria-label/title 必须保留 app.status.* 三条文案。 -->
    <div class="conn conn-{status}" role="status" aria-label={$t('app.status.' + status)} title={$t('app.status.' + status)}>
      <span class="conn-dot"></span>
    </div>
    <button class="fs-btn" aria-label={pageFullscreen ? $t('app.fullscreen.exit') : $t('app.fullscreen.enter')} onclick={togglePageFullscreen}>
      {#if pageFullscreen}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
      {/if}
    </button>
  </div>

  {#if DEMO}
    <div class="demo-banner">
      <span class="demo-banner-text">{$t('demo.banner')}</span>
      <button class="demo-drop" onclick={() => demo?.director.playDropScene()}>{$t('demo.tryOffline')}</button>
      <a class="demo-cta" href="https://pocketshell.net/#quickstart" target="_blank" rel="noopener">{$t('demo.installCta')}</a>
    </div>
  {/if}

  <div class="tabs-wrap">
    <TopTabs tabs={topTabsView} activeId={activeTopId} onSelect={selectTop} onNew={newSession} onCloseTab={closeTopTab} onCopyPath={copyTabPath} dirtyIds={fileDirty} />
  </div>

  {#if notice}<div class="notice">{notice}</div>{/if}
  {#if status !== "online"}
    <div class="banner">{everOnline ? $t('app.banner') : $t('app.bannerFirstConnect')}</div>
  {/if}

  <div class="top" style="flex: {topFlex} 1 0;" role="application" aria-label={$t('app.topAria')} bind:this={topEl}>
    {#each topSessions as s (s.name)}
      <TerminalView
        {conn}
        sessionId={s.name}
        active={activeTopId === s.name}
        closed={s.closed ?? false}
        fontSize={settings.fontSize}
        fontFamily={settings.fontFamily}
        historyLines={settings.historyLines}
        onReady={(id, t) => terms.set(id, t)}
        onReseedReady={(id, fn) => reseeders.set(id, fn)}
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
        onAutoEdit={() => (pendingEdit = null)}
        onNavigate={(p) => navigateFile(t.id, p)} />
    {/each}
    {#if topSessions.length === 0 && fileTabs.length === 0}
      <div class="hint">
        <div class="hint-title">{$t('app.empty.title')}</div>
        <div class="hint-body">{$t('app.empty.body')}</div>
      </div>
    {/if}
    {#if copyMode}
      <TermCopyOverlay {conn} sessionId={activeId} term={activeTerm()}
        onClose={() => (copyMode = false)}
        onCopy={(text) => {
          if (text.trim()) { writeClip(text, tr("app.toast.copiedSelection")); copyMode = false; }
          else showToast(tr("app.toast.noSelection"));
        }} />
    {/if}
  </div>

  {#if !fullscreen}
    <StatusBar
      branch={gitBranch} dirty={gitDirty}
      latency={metrics.latency} rxBytes={metrics.rxBytes} elapsedMs={metrics.elapsedMs}
      online={status === "online"}
      ctxUsed={activeSessionMeta?.ctxUsed} ctxTotal={activeSessionMeta?.ctxTotal}
      onDown={onDividerDown} onMove={onDividerMove} onUp={onDividerUp} />
  {/if}
  <div class="bottom" class:hidden={fullscreen} style="flex: {1 - topFlex} 1 0;">
    <div class="panel-slot" class:hidden={bottomPanel !== "file"}>
      <FilePanel {conn} onOpenFile={(p) => openFile(p, "code")} onOpenDiff={(p) => openFile(p, "diff")} onCd={(p) => sendActive('cd ' + JSON.stringify(p) + '\n')} {getFocusedPwd} {rootTick} refreshTick={treeTick} onToast={showToast} onToastRich={(title, detail, ms) => showToast(title, { detail, ms })} onNewFile={handleNewFile} />
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
          // 查不到版本号（网络不通 / GitHub 接口限流 / 仓库关闭更新）时 latest
          // 为 null。这跟「确实已是最新」是两回事，不能都报「已是最新版本」——
          // 否则真有新版时用户只会看到一句安心话，永远发现不了更新。
          else if (!updInfo?.latest) showToast(tr("update.checkFailed"), { detail: tr("update.checkFailedDetail"), ms: 3500 });
          else showToast(tr("update.upToDate"));
        }} />
    </div>
    <div class="panel-slot" class:hidden={bottomPanel !== "kbd"}>
      <Keyboard onText={sendActive} onCommand={runCommand} vibrate={settings.vibrate}
        layout={settings.layout} kbLayout={settings.kbLayout} {hints} {onHint} />
    </div>
    <div class="panel-slot" class:hidden={bottomPanel !== "snip"}>
      <SnippetPanel {conn} onInsert={sendActive} />
    </div>
  </div>

  <!-- barEl wraps the tab bar so App can attach the panel-swipe listeners
       (swipe left/right on the bar to switch panels; see bottomSwipe). -->
  <div class="bar-swipe" bind:this={barEl}>
    <BottomBar active={bottomPanel} taskBadge={sessions.some((s) => s.state === "wait")} onSelect={openPanel} />
  </div>
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

{#if kbTutorial}
  <KeyboardTutorial tutorial={kbTutorial} onClose={closeKbTutorial} />
{/if}

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    /* 机身顶部一层极弱暖光，让石墨底不死板；浅色主题下 --shell-glow 为
       transparent（暖白底铺橙渐变会显脏）。 */
    background:
      radial-gradient(130% 55% at 50% -8%, var(--shell-glow), transparent 62%),
      var(--bg);
    overflow: hidden;
    position: relative;
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    padding: 0 13px;
    background: transparent;
    border-bottom: 1px solid var(--line);
    flex: 0 0 auto;
  }
  .demo-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 13px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    font-size: 11px;
    flex: 0 0 auto;
    overflow-x: auto;
    white-space: nowrap;
  }
  .demo-banner-text { color: var(--dim); }
  .demo-drop {
    border: 1px solid var(--accent);
    color: var(--accent);
    background: transparent;
    border-radius: 999px;
    padding: 2px 9px;
    font-size: 11px;
    line-height: 1.4;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .demo-cta {
    color: var(--accent);
    text-decoration: none;
    margin-left: auto;
    flex: 0 0 auto;
  }
  .brand {
    font-weight: 700;
    letter-spacing: 0.2px;
    font-size: 0.84rem;
    color: var(--text);
  }
  .brand b { color: var(--brand-sig); font-weight: 700; }
  .version {
    font-size: 0.56rem;
    color: var(--dimmer);
    font-weight: 500;
    letter-spacing: 0.06em;
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
  /* 连接状态：纯色点，25px 命中区（与全屏钮同高） */
  .conn {
    margin-left: auto;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 25px;
    height: 25px;
    color: var(--dim);
  }
  .conn-online { color: var(--ok); }
  /* 连接中缓慢呼吸：状态点是"正在发生"而不是一个静止结论（14 期需求 5）。
     reduced-motion 下由 app.css 统一关掉。 */
  .conn-connecting {
    color: var(--amber);
    animation: conn-breathe 1.6s var(--ease-breathe, ease-in-out) infinite alternate;
  }
  @keyframes conn-breathe { from { opacity: 0.4; } to { opacity: 1; } }
  .conn-offline { color: var(--red); }
  .conn-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 6px currentColor;
  }
  .fs-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 27px;
    height: 25px;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--dim);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }
  .fs-btn svg { width: 16px; height: 16px; display: block; }
  .fs-btn:hover { color: var(--text); }
  .fs-btn:active { background: var(--keyhi); }

  /* 索引卡片 tab 自带下边线与内边距，外层不再加 padding，否则卡片压不住线 */
  .tabs-wrap {
    flex: 0 0 auto;
    position: relative;
    overflow: hidden;
    background: transparent;
    display: flex;
    align-items: stretch;
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

  /* 与索引卡片 tab 连成一体：不再是浮在底色上的圆角盒子，改为通栏平铺，
     卡片底边直接坐在这块区域上沿。 */
  .top {
    position: relative;
    min-height: 0;
    overflow: hidden;
    background: var(--term-bg);
    border: 0;
    border-radius: 0;
    margin: 0;
    /* Phase 1 defensive fix (best-effort pending real-device RCA): keep vertical
       scroll native but let horizontal drags stay as pointer events instead of
       being resolved into a native gesture that cancels them. */
    touch-action: pan-y;
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

  .bottom {
    min-height: 0;
    overflow: hidden;
    background: var(--bg);
    display: flex;
    flex-direction: column;
  }
  /* Panel swipe now lives on the tab bar, not the content area. The wrapper is
     layout-transparent (the bar keeps its own flex:0 0 auto); pan-y lets a
     horizontal swipe reach our pointer handlers instead of a native gesture. */
  .bar-swipe { flex: 0 0 auto; touch-action: pan-y; }
  .panel-slot {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .bottom.hidden, .panel-slot.hidden { display: none; }

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
