<!-- app/src/components/SettingsPanel.svelte -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import type { Connection } from "../lib/net/connection";
  import type { Settings } from "../lib/settings";
  import { webPushErrorKey, pushSendErrorKey, defaultNotifyConfig, type NotifyConfig, type WebhookCfg, type WebhookKind } from "../lib/notify";
  import { subscribeAndReport, unsubscribeBrowser } from "../lib/web-push-client";
  import DeviceManager from "./DeviceManager.svelte";
  import { detectPairing } from "../lib/net/pair-detect";
  import HintManager from "./HintManager.svelte";
  import OperationGuide from "./OperationGuide.svelte";
  import { hardReset } from "../lib/cache-admin";
  import { listThemes, customThemeInfo, applyThemeAsync, type ThemeEntry } from "../lib/theme";
  import { customThemeName } from "../lib/theme-css";
  import { FONTS, applyFont } from "../lib/font";
  import { KB_LAYOUTS, HISTORY_LINE_CHOICES } from "../lib/settings";
  import { resetTutorial } from "../lib/term/kb-tutorial";

  let { conn, settings, onChange, currentVersion, onCheckUpdate }: {
    conn: Connection; settings: Settings; onChange: (s: Settings) => void;
    currentVersion: string; onCheckUpdate: () => Promise<void>;
  } = $props();

  function update<K extends keyof Settings>(k: K, v: Settings[K]) {
    onChange({ ...settings, [k]: v });
  }

  let showDevices = $state(false);
  let devicesPrefill = $state("");
  let showHints = $state(false);

  // ---- Themes ----
  // The list is read from CSS, not from a table in TS: `theme-tokens.css` carries
  // the built-in manifest and the agent's `/theme/custom.css` carries the user's
  // own (design §4.4). `themeTick` re-runs the read after anything that could
  // have changed it — an import, a delete, or a switch that swapped the
  // stylesheet's href.
  let themeTick = $state(0);
  let themes = $derived.by((): ThemeEntry[] => { void themeTick; return listThemes(); });
  let themeInfo = $derived.by(() => { void themeTick; return customThemeInfo(); });

  /**
   * Built-ins have an i18n name; a custom theme shows its **file name**, not
   * its id — the id is a slug of the file name (`Tokyo Night` → `tokyo-night`)
   * and showing that would rename the user's theme on screen.
   */
  function themeLabel(e: ThemeEntry): string {
    return e.custom ? e.name ?? customThemeName(e.id) ?? e.id : tr(`settings.theme.${e.id}`);
  }

  // Switching is async for custom themes only: the agent ships the full token
  // set for the *selected* theme, so a custom one needs a fresh stylesheet
  // before `data-theme` is written (otherwise a frame renders with no tokens).
  // applyThemeAsync handles both, and App.svelte's own applyTheme on the way
  // through onChange is then a no-op re-application.
  async function pickTheme(id: Settings["theme"]) {
    await applyThemeAsync(id);
    themeTick++;
    update("theme", id);
  }

  let showImport = $state(false);
  let impName = $state("");
  let impText = $state("");
  let impMsg = $state<{ ok: boolean; text: string } | null>(null);
  let importing = $state(false);

  async function doImport() {
    const name = impName.trim();
    if (!name || !impText.trim() || importing) return;
    importing = true;
    impMsg = null;
    try {
      // Over the authed WS rather than POST /theme/import: that route is
      // loopback + bearer (a local-script path), and a phone is neither.
      const r = await conn.rpc("theme.import", { name, text: impText }) as
        { ok: true; id: string; name: string; overwritten: boolean } | { ok: false; reason: string };
      if (!r.ok) {
        impMsg = { ok: false, text: tr(`settings.theme.importErr.${r.reason}`) };
        return;
      }
      // Report the name the user typed, but name the id too when the two differ
      // — the id is what the theme is addressed by, and silently storing
      // "Tokyo Night" as `tokyo-night` with no word about it is the kind of
      // thing that turns into "why is my theme called that".
      impMsg = {
        ok: true,
        text: tr(r.overwritten ? "settings.theme.importReplaced" : "settings.theme.importOk", { name: r.name })
          + (r.id === r.name ? "" : tr("settings.theme.importSlugged", { id: r.id })),
      };
      impText = "";
      // Re-pull the stylesheet so the new theme is in the manifest, then switch
      // to it — importing a theme you then have to go and select is a pointless
      // second step.
      await pickTheme(`custom:${r.id}`);
    } catch {
      impMsg = { ok: false, text: tr("settings.theme.importErr.offline") };
    } finally {
      importing = false;
    }
  }

  async function deleteTheme(e: ThemeEntry) {
    // The **file name**, not the id: the id is a lossy slug, so it cannot name
    // a file (`Tokyo Night` and `tokyo_night` share one). The agent's
    // `remove()` takes the file name for the same reason.
    const name = e.name ?? customThemeName(e.id);
    if (!name || !confirm(tr("settings.theme.deleteConfirm", { name }))) return;
    try {
      const r = await conn.rpc("theme.remove", { name }) as { removed: boolean };
      if (!r.removed) { impMsg = { ok: false, text: tr("settings.theme.deleteFailed") }; return; }
    } catch {
      impMsg = { ok: false, text: tr("settings.theme.importErr.offline") };
      return;
    }
    // Deleting the theme you are wearing would leave data-theme pointing at a
    // block that no longer exists (i.e. silently the default). Move first.
    if (settings.theme === e.id) await pickTheme("cream-dark");
    else { await applyThemeAsync(settings.theme); themeTick++; }
  }

  // 字体切换是同步的：令牌都在 fonts.css 里，不像自定义主题需要等 agent 供给。
  //
  // 顺序很关键，不能颠倒：update() 用的是组件持有的 settings prop 快照（在这次
  // 点击之前捕获的），它的展开写会把整份设置连同旧的 bootFontUrl 一起落盘。
  // 如果先调 applyFont 再调 update，applyFont 刚写下的新 bootFontUrl 会被
  // update() 那份过期快照原样覆盖回旧值——下次冷启动 index.html 的内联脚本会
  // 去 preload 用户已经切走的那套字体，真正在用的那套反而没预取，首帧防闪烁
  // 机制形同虚设。所以必须让 applyFont 最后写：先用旧快照落盘 fontFamily，
  // 再用 applyFont 写 data-font 与 bootFontUrl，这一步之后没有别的写入能覆盖它。
  function pickFont(id: Settings["fontFamily"]) {
    update("fontFamily", id);
    applyFont(id);
  }

  // ---- 键盘键位 ----
  function pickKbLayout(id: Settings["kbLayout"]) {
    update("kbLayout", id);
  }

  // 清掉两套教程的「看过」标记，下次切到 layered / flick 会再弹。
  // 不在这里直接弹：弹窗归 App 管（它才是 overlay 的挂载处），
  // 而且用户点「重看」时多半正想切布局，下一次切换弹出来正好。
  let replayed = $state(false);
  function replayKbTutorial() {
    resetTutorial("layered");
    resetTutorial("flick");
    replayed = true;   // 只用于按钮文案反馈，见下方模板
  }

  // 剪贴板读取必须在 click handler 的 user gesture 内发起 —— 这是浏览器允许
  // readText() 的唯一路径（Safari/iOS 无权限降级，Chrome 需已授权+有焦点）。
  // 失败一律静默：iOS 上用户不点系统「粘贴」菜单就会抛 NotAllowedError，
  // 那不是错误，手动粘贴即可，弹个报错反而莫名其妙。
  async function openDevices() {
    if (showDevices) { showDevices = false; return; }
    devicesPrefill = "";
    try {
      const text = await navigator.clipboard?.readText?.();
      devicesPrefill = detectPairing(text) ?? "";
    } catch { /* 静默：见上方注释 */ }
    showDevices = true;
  }
  let showGuide = $state(false);
  let checkingUpdate = $state(false);
  async function checkNow() {
    checkingUpdate = true;
    try { await onCheckUpdate(); } finally { checkingUpdate = false; }
  }

  function clearCacheAndReload() {
    if (!confirm(tr("settings.cache.confirm"))) return;
    void hardReset();
  }

  // ---- Notifications ----
  // Section is collapsed by default (and every channel defaults off in
  // NotifyConfig itself) — nothing here touches the user's environment until
  // they explicitly flip a toggle.
  const TOOLS: Array<"claude" | "codex" | "opencode" | "kimi"> = ["claude", "codex", "opencode", "kimi"];
  const WEBHOOK_KINDS: WebhookKind[] = ["wecom", "feishu", "slack", "discord", "custom"];
  const WIRE_REASONS = new Set(["parse_error", "write_error", "read_error", "conflict", "opencode_not_found", "kimi_not_found"]);

  let notifyOpen = $state(false);
  let notifyLoaded = $state(false);
  let cfg = $state<NotifyConfig>(defaultNotifyConfig());
  let wireError = $state<Record<string, string | null>>({ claude: null, codex: null, opencode: null, kimi: null });
  let webPushError = $state<string | null>(null);
  let addingWebhook = $state(false);
  let whForm = $state<{ name: string; kind: WebhookKind; url: string; secret: string; template: string }>(
    { name: "", kind: "wecom", url: "", secret: "", template: "" }
  );
  let testMsg = $state<Record<string, { ok: boolean; text: string }>>({});

  // Web Push only works from an installed (standalone) PWA on iOS Safari.
  const isIOS = typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = typeof navigator !== "undefined" &&
    ((navigator as unknown as { standalone?: boolean }).standalone === true ||
      (typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches));
  const showIosHint = isIOS && !isStandalone;

  async function toggleNotifyOpen() {
    notifyOpen = !notifyOpen;
    if (!notifyOpen || notifyLoaded) return;
    notifyLoaded = true;
    try {
      const loaded = (await conn.notifyGetConfig()) as Partial<NotifyConfig>;
      cfg = { ...defaultNotifyConfig(), ...loaded };
    } catch {
      // Keep the defaults visible; per-action failures (wire/test/subscribe)
      // still surface their own fail-loud errors below.
    }
  }

  // agent 侧发送失败原因：认得出的给解释，认不出的原样显示原文（不吞错）。
  function sendErrText(raw: string): string {
    const key = pushSendErrorKey(raw);
    return key ? tr(key) : raw;
  }

  function reasonText(reason?: string, detail?: string): string {
    if (reason && WIRE_REASONS.has(reason)) return tr(`notify.reason.${reason}`);
    return detail || tr("notify.wireFailed");
  }

  async function persistCfg() { await conn.notifySetConfig(cfg); }

  async function toggleTool(tool: "claude" | "codex" | "opencode" | "kimi", on: boolean) {
    const r = on ? await conn.notifyWire(tool) : await conn.notifyUnwire(tool);
    if (!r.ok) { wireError = { ...wireError, [tool]: reasonText(r.reason, r.detail) }; return; }
    wireError = { ...wireError, [tool]: null };
    cfg = { ...cfg, tools: { ...cfg.tools, [tool]: on } };
    await persistCfg();
  }

  // 需求 5：接管 CC 的 statusLine 取上下文用量。单独一个开关而不是并进
  // 工具列表——它不产生通知，混在一起用户会以为开了就能收推送。
  let contextError = $state<string | null>(null);
  async function toggleContext(on: boolean) {
    const r = on ? await conn.contextWire() : await conn.contextUnwire();
    if (!r.ok) { contextError = reasonText(r.reason, r.detail); return; }
    contextError = null;
    cfg = { ...cfg, contextStatusline: on };
    await persistCfg();
  }

  async function toggleWebPush(on: boolean) {
    if (!on) {
      await conn.notifyUnsubscribe();
      // 浏览器侧也要退订，否则推送服务里留着一条再不会用到的活订阅。放在
      // agent 之后、且失败不拦关闭流程：此时 agent 已经不发了，退订失败只是
      // 不整洁，不该让开关卡在「开」上。
      await unsubscribeBrowser().catch(() => {});
      cfg = { ...cfg, webPush: false };
      await persistCfg();
      webPushError = null;
      return;
    }
    webPushError = null;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { webPushError = tr("notify.permDenied"); return; }
      await subscribeAndReport(conn);
      cfg = { ...cfg, webPush: true };
      await persistCfg();
    } catch (e) {
      // 认得出的失败给中文解释（最常见：连不上 FCM），认不出的原样显示英文，
      // 不吞错误。
      const key = webPushErrorKey(e);
      webPushError = key ? tr(key) : e instanceof Error ? e.message : String(e);
    }
  }

  function setIncludeSummary(on: boolean) {
    cfg = { ...cfg, includeSummary: on };
    void persistCfg();
  }
  function setDedupeSeconds(v: number) {
    if (!Number.isFinite(v)) return;
    cfg = { ...cfg, dedupeMs: Math.max(0, Math.round(v * 1000)) };
    void persistCfg();
  }

  function newWebhookId(): string {
    return `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function addWebhook() {
    if (!whForm.name.trim() || !whForm.url.trim()) return;
    const item: WebhookCfg = {
      id: newWebhookId(), name: whForm.name.trim(), kind: whForm.kind, url: whForm.url.trim(), enabled: true,
      secret: whForm.secret.trim() || undefined, template: whForm.template.trim() || undefined,
    };
    cfg = { ...cfg, webhooks: [...cfg.webhooks, item] };
    whForm = { name: "", kind: "wecom", url: "", secret: "", template: "" };
    addingWebhook = false;
    void persistCfg();
  }
  function removeWebhook(w: WebhookCfg) {
    if (!confirm(tr("notify.webhook.delConfirm", { name: w.name }))) return;
    cfg = { ...cfg, webhooks: cfg.webhooks.filter((x) => x.id !== w.id) };
    void persistCfg();
  }
  function patchWebhook(id: string, patch: Partial<WebhookCfg>) {
    cfg = { ...cfg, webhooks: cfg.webhooks.map((w) => (w.id === id ? { ...w, ...patch } : w)) };
    void persistCfg();
  }
  async function testWebhook(id: string) {
    const r = await conn.notifyTestWebhook(id);
    testMsg = { ...testMsg, [id]: r.ok ? { ok: true, text: tr("notify.webhook.testOk") } : { ok: false, text: r.error || tr("notify.wireFailed") } };
  }

  // 演示态：这几个入口在沙盘里没有意义（没有真设备、没有真二进制可更新）。
  const DEMO = import.meta.env.VITE_POCKETSHELL_DEMO === "1";
</script>

<div class="stg-scroll">
<div class="stg">
  <!-- 键位布局。放最上面：它决定整个键盘长什么样，是这一屏里影响最大的设置。
       与下面的「键帽标注」（Mac/Win）是两回事——那个只换 Cmd/Win 的字。
       用一行一项而不是 .seg：三个名字加说明在 390px 下排不开一行。 -->
  <div class="set col">
    <div class="grow">
      <div class="label">{$t('settings.kbLayout.label')}</div>
      <div class="desc">{$t('settings.kbLayout.desc')}</div>
    </div>
    <div class="themes" role="radiogroup" aria-label={$t('settings.kbLayout.label')}>
      {#each KB_LAYOUTS as id (id)}
        <button class="theme" role="radio" aria-checked={settings.kbLayout === id}
          class:on={settings.kbLayout === id} onclick={() => pickKbLayout(id)}>
          <span class="tick" aria-hidden="true"></span>
          <span class="tname">
            {$t(`settings.kbLayout.${id}`)}
            <s>{$t(`settings.kbLayout.${id}Desc`)}</s>
          </span>
        </button>
      {/each}
    </div>
  </div>

  <!-- 重看教程：教程只在首次切到新布局时弹，这里是唯一的重看入口 -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.kbLayout.replay')}</div>
      <div class="desc">{$t('settings.kbLayout.replayDesc')}</div>
    </div>
    <button class="btn" onclick={replayKbTutorial} disabled={replayed}>
      {replayed ? $t('settings.kbLayout.replayDone') : $t('settings.kbLayout.replayBtn')}
    </button>
  </div>

  <!-- Theme. A row per palette rather than the usual .seg: seven segments do not
       fit at 390px (and overflow outright in English), and a colour scheme is
       the one setting worth previewing before you pick it. -->
  <div class="set col">
    <div class="grow">
      <div class="label">{$t('settings.theme.label')}</div>
      <div class="desc">{$t('settings.theme.desc')}</div>
    </div>
    <div class="themes" role="radiogroup" aria-label={$t('settings.theme.label')}>
      <button class="theme" role="radio" aria-checked={settings.theme === "system"}
        class:on={settings.theme === "system"} onclick={() => pickTheme("system")}>
        <span class="tick" aria-hidden="true"></span>
        <span class="tname">
          {$t('settings.theme.system')}
          <s>{$t('settings.theme.systemDesc')}</s>
        </span>
      </button>
      {#each themes as e (e.id)}
        <div class="trow" class:on={settings.theme === e.id}>
          <button class="theme" role="radio" aria-checked={settings.theme === e.id}
            onclick={() => pickTheme(e.id)}>
            <span class="tick" aria-hidden="true"></span>
            <span class="tname">
              {themeLabel(e)}
              {#if e.custom}<em class="cbadge">{$t('settings.theme.custom')}</em>{/if}
            </span>
            <span class="sw" aria-hidden="true">
              <!-- colors is null when the agent has not supplied this theme's
                   swatches (offline, or it was deleted elsewhere): paint an
                   empty strip rather than a wrong one. -->
              {#each e.colors ?? [] as c}<i style="background:{c}"></i>{/each}
            </span>
            <span class="tag">
              {e.scheme === "light" ? $t('settings.theme.schemeLight') : $t('settings.theme.schemeDark')}
            </span>
          </button>
          {#if e.custom}
            <button class="tdel" onclick={() => deleteTheme(e)} aria-label={$t('settings.theme.delete')}
              title={$t('settings.theme.delete')}>×</button>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Why a theme did not show up. Only reachable through the CSS manifest:
         the stylesheet is fetched with <link>, which exposes no headers. -->
    {#if themeInfo.truncated}
      <p class="tnote">{$t('settings.theme.truncated', { values: { total: themeInfo.total, shown: themeInfo.shown } })}</p>
    {/if}
    {#if themeInfo.skipped.length}
      <p class="tnote warn">{$t('settings.theme.skippedTitle', { values: { count: themeInfo.skipped.length } })}</p>
      <ul class="tskips">
        {#each themeInfo.skipped as s (s.file + s.reason)}
          <li>{$t(`settings.theme.skip.${s.reason}`, { values: { file: s.file } })}</li>
        {/each}
      </ul>
    {/if}

    <p class="tnote">{$t('settings.theme.customHint')}</p>
    <div class="timport-head">
      <button class="btn" disabled={DEMO} title={DEMO ? $t('demo.disabled') : undefined}
        onclick={() => { showImport = !showImport; impMsg = null; }}>
        {showImport ? $t('settings.theme.importClose') : $t('settings.theme.import')}
      </button>
      {#if impMsg}<span class="tmsg" class:ok={impMsg.ok}>{impMsg.text}</span>{/if}
    </div>
    {#if showImport}
      <div class="timport">
        <p class="tnote">{$t('settings.theme.importDesc')}</p>
        <input bind:value={impName} placeholder={$t('settings.theme.importName')} />
        <textarea bind:value={impText} rows="4" placeholder={$t('settings.theme.importText')}></textarea>
        <button class="save" disabled={importing || !impName.trim() || !impText.trim()} onclick={doImport}>
          {$t('settings.theme.importSubmit')}
        </button>
      </div>
    {/if}
  </div>

  <!-- Group tabs by type (req 4) -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.groupTabs.label')}</div>
      <div class="desc">{$t('settings.groupTabs.desc')}</div>
    </div>
    <div class="seg">
      <button class:on={!settings.groupTabsByType} onclick={() => update("groupTabsByType", false)}>{$t('settings.groupTabs.off')}</button>
      <button class:on={settings.groupTabsByType} onclick={() => update("groupTabsByType", true)}>{$t('settings.groupTabs.on')}</button>
    </div>
  </div>

  <!-- Language -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.language.label')}</div>
      <div class="desc">{$t('settings.language.desc')}</div>
    </div>
    <div class="seg">
      <button class:on={settings.language === "zh"} onclick={() => update("language", "zh")}>中文</button>
      <button class:on={settings.language === "en"} onclick={() => update("language", "en")}>English</button>
    </div>
  </div>

  <!-- Font. 与主题同样用一行一项而不是 .seg：五个字体名在 390px 下塞不进一排，
       而且字体是「看一眼才知道要不要」的设置，值得给每行一段真实渲染的预览。 -->
  <div class="set col">
    <div class="grow">
      <div class="label">{$t('settings.font.label')}</div>
      <div class="desc">{$t('settings.font.desc')}</div>
    </div>
    <div class="themes" role="radiogroup" aria-label={$t('settings.font.label')}>
      {#each FONTS as f (f.id)}
        <button class="theme" role="radio" aria-checked={settings.fontFamily === f.id}
          class:on={settings.fontFamily === f.id} onclick={() => pickFont(f.id)}>
          <span class="tick" aria-hidden="true"></span>
          <span class="tname">{$t(`settings.font.${f.id}`)}</span>
          <!-- 用该字体真实渲染的预览：框线字形、易混字符、连字各一组。
               渲染这一行就会触发该字体下载——打开设置面板会下满 5 套 Regular
               （约 200KB，之后走 SW 的 /fonts/ cache-first）。这是「切之前先看看
               长什么样」的代价，设计 §4.5 明确接受。 -->
          <span class="fprev" style="font-family: var(--font-mono-{f.id})" aria-hidden="true"
            >─┼┐ 0O1lI =&gt;</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Font size -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.fontSize.label')}</div>
      <div class="desc">{$t('settings.fontSize.desc')}</div>
    </div>
    <input type="range" min="10" max="18" step="0.5" value={settings.fontSize}
      oninput={(e) => update("fontSize", Number((e.target as HTMLInputElement).value))} />
    <span class="val">{settings.fontSize}</span>
  </div>

  <!-- History lines：分段按钮而不是自由输入，避免用户填个 50000 把自己卡死 -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.historyLines.label')}</div>
      <div class="desc">{$t('settings.historyLines.desc')}</div>
    </div>
    <div class="seg">
      {#each HISTORY_LINE_CHOICES as n}
        <button class:on={settings.historyLines === n}
          onclick={() => update("historyLines", n)}>{n}</button>
      {/each}
    </div>
  </div>

  <!-- Keyboard layout -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.layout.label')}</div>
      <div class="desc">{$t('settings.layout.desc')}</div>
    </div>
    <div class="seg">
      <button class:on={settings.layout === "mac"} onclick={() => update("layout", "mac")}>Mac</button>
      <button class:on={settings.layout === "win"} onclick={() => update("layout", "win")}>Win</button>
    </div>
  </div>

  <!-- Vibration -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.vibrate.label')}</div>
      <div class="desc">{$t('settings.vibrate.desc')}</div>
    </div>
    <div class="seg">
      <button class:on={settings.vibrate === "off"} onclick={() => update("vibrate", "off")}>{$t('settings.vibrate.off')}</button>
      <button class:on={settings.vibrate === "light"} onclick={() => update("vibrate", "light")}>{$t('settings.vibrate.light')}</button>
      <button class:on={settings.vibrate === "medium"} onclick={() => update("vibrate", "medium")}>{$t('settings.vibrate.medium')}</button>
      <button class:on={settings.vibrate === "strong"} onclick={() => update("vibrate", "strong")}>{$t('settings.vibrate.strong')}</button>
    </div>
  </div>

  <!-- Device management -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.devices.label')}</div>
      <div class="desc">{$t('settings.devices.desc')}</div>
    </div>
    <button class="btn" disabled={DEMO} title={DEMO ? $t('demo.disabled') : undefined} onclick={openDevices}>
      {showDevices ? $t('settings.devices.close') : $t('settings.devices.manage')}
    </button>
  </div>

  <!-- Custom input suggestions (req 5) -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('hints.title')}</div>
      <div class="desc">{$t('hints.desc')}</div>
    </div>
    <button class="btn" onclick={() => (showHints = !showHints)}>
      {showHints ? $t('hints.close') : $t('hints.entry')}
    </button>
  </div>
  {#if showHints}<HintManager {conn} />{/if}

  <!-- Operation guide -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('guide.title')}</div>
      <div class="desc">{$t('guide.desc')}</div>
    </div>
    <button class="btn" onclick={() => (showGuide = true)}>{$t('guide.open')}</button>
  </div>

  <!-- Cache reset: escape hatch when the PWA cache misbehaves -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.cache.label')}</div>
      <div class="desc">{$t('settings.cache.desc')}</div>
    </div>
    <button class="btn" onclick={clearCacheAndReload}>{$t('settings.cache.button')}</button>
  </div>

  <!-- Notifications (collapsible, collapsed + all-off by default) -->
  <button class="set notify-head" onclick={toggleNotifyOpen} aria-expanded={notifyOpen}>
    <div class="grow">
      <div class="label">{$t('notify.title')}</div>
      <div class="desc">{$t('notify.desc')}</div>
    </div>
    <span class="chev">{notifyOpen ? "▾" : "▸"}</span>
  </button>
  {#if notifyOpen}
    <div class="nsub">{$t('notify.triggers')}</div>
    {#each TOOLS as tool (tool)}
      <div class="set">
        <div class="grow">
          <div class="label">{$t(`notify.tool.${tool}`)}</div>
          {#if wireError[tool]}<div class="err">{wireError[tool]}</div>{/if}
        </div>
        <div class="seg">
          <button class:on={!cfg.tools[tool]} onclick={() => toggleTool(tool, false)}>{$t('notify.off')}</button>
          <button class:on={cfg.tools[tool]} onclick={() => toggleTool(tool, true)}>{$t('notify.on')}</button>
        </div>
      </div>
    {/each}
    <p class="nt-hint">{$t('notify.rewireHint')}</p>

    <div class="nsub">{$t('notify.contextTitle')}</div>
    <div class="set">
      <div class="grow">
        <div class="label">{$t('notify.contextLabel')}</div>
        {#if contextError}<div class="err">{contextError}</div>{/if}
      </div>
      <div class="seg">
        <button class:on={!cfg.contextStatusline} onclick={() => toggleContext(false)}>{$t('notify.off')}</button>
        <button class:on={cfg.contextStatusline} onclick={() => toggleContext(true)}>{$t('notify.on')}</button>
      </div>
    </div>
    <p class="nt-hint">{$t('notify.contextDesc')}</p>

    <div class="nsub">{$t('notify.delivery')}</div>
    <div class="set">
      <div class="grow">
        <div class="label">{$t('notify.webpush.label')}</div>
        {#if showIosHint}<div class="desc">{$t('notify.webpush.iosHint')}</div>{/if}
        {#if webPushError}<div class="err">{webPushError}</div>{/if}
        <!-- agent 侧发送失败：开关显示「开」但服务器发不出去，不显示的话这个
             状态完全静默。只在推送开着时有意义。 -->
        {#if cfg.webPush && cfg.webPushLastError}
          <div class="err">{$t('notify.webpush.sendFailed')}: {sendErrText(cfg.webPushLastError)}</div>
        {/if}
      </div>
      <div class="seg">
        <button class:on={!cfg.webPush} onclick={() => toggleWebPush(false)}>{$t('notify.off')}</button>
        <button class:on={cfg.webPush} onclick={() => toggleWebPush(true)}>{$t('notify.on')}</button>
      </div>
    </div>

    <div class="nsub webhook-head">
      <span>{$t('notify.webhook.label')}</span>
      <button class="add-btn" onclick={() => (addingWebhook = !addingWebhook)}>
        {addingWebhook ? $t('notify.webhook.cancel') : $t('notify.webhook.add')}
      </button>
    </div>
    {#if addingWebhook}
      <div class="wh-form">
        <input bind:value={whForm.name} placeholder={$t('notify.webhook.name')} />
        <select bind:value={whForm.kind}>
          {#each WEBHOOK_KINDS as k (k)}<option value={k}>{$t(`notify.webhook.kinds.${k}`)}</option>{/each}
        </select>
        <input bind:value={whForm.url} placeholder={$t('notify.webhook.url')} />
        <input type="password" bind:value={whForm.secret} placeholder={$t('notify.webhook.secret')} />
        <textarea bind:value={whForm.template} placeholder={$t('notify.webhook.template')} rows="2"></textarea>
        <button class="save" onclick={addWebhook}>{$t('notify.webhook.add')}</button>
      </div>
    {/if}
    {#each cfg.webhooks as w (w.id)}
      <div class="wh-row">
        <div class="wh-line1">
          <input class="wh-name" value={w.name}
            onchange={(e) => patchWebhook(w.id, { name: (e.target as HTMLInputElement).value })} />
          <select value={w.kind}
            onchange={(e) => patchWebhook(w.id, { kind: (e.target as HTMLSelectElement).value as WebhookKind })}>
            {#each WEBHOOK_KINDS as k (k)}<option value={k}>{$t(`notify.webhook.kinds.${k}`)}</option>{/each}
          </select>
          <div class="seg">
            <button class:on={!w.enabled} onclick={() => patchWebhook(w.id, { enabled: false })}>{$t('notify.off')}</button>
            <button class:on={w.enabled} onclick={() => patchWebhook(w.id, { enabled: true })}>{$t('notify.on')}</button>
          </div>
          <button class="del" onclick={() => removeWebhook(w)} aria-label={$t('common.delete')}>×</button>
        </div>
        <input class="wh-url" value={w.url} placeholder={$t('notify.webhook.url')}
          onchange={(e) => patchWebhook(w.id, { url: (e.target as HTMLInputElement).value })} />
        <input type="password" class="wh-url" value={w.secret ?? ""} placeholder={$t('notify.webhook.secret')}
          onchange={(e) => patchWebhook(w.id, { secret: (e.target as HTMLInputElement).value || undefined })} />
        <textarea class="wh-tpl" rows="2" value={w.template ?? ""} placeholder={$t('notify.webhook.template')}
          onchange={(e) => patchWebhook(w.id, { template: (e.target as HTMLTextAreaElement).value || undefined })}></textarea>
        <div class="wh-actions">
          <button class="btn" onclick={() => testWebhook(w.id)}>{$t('notify.webhook.test')}</button>
          {#if testMsg[w.id]}<span class="wh-test-msg" class:ok={testMsg[w.id].ok}>{testMsg[w.id].text}</span>{/if}
        </div>
        {#if w.lastError}<div class="err">{$t('notify.webhook.lastError')}: {w.lastError}</div>{/if}
      </div>
    {/each}
    {#if cfg.webhooks.length === 0 && !addingWebhook}<div class="wh-empty">{$t('notify.webhook.empty')}</div>{/if}

    <div class="nsub">{$t('notify.content')}</div>
    <div class="set">
      <div class="grow">
        <div class="label">{$t('notify.includeSummary')}</div>
        <div class="desc">{$t('notify.summaryRisk')}</div>
      </div>
      <div class="seg">
        <button class:on={!cfg.includeSummary} onclick={() => setIncludeSummary(false)}>{$t('notify.off')}</button>
        <button class:on={cfg.includeSummary} onclick={() => setIncludeSummary(true)}>{$t('notify.on')}</button>
      </div>
    </div>
    <div class="set">
      <div class="grow">
        <div class="label">{$t('notify.dedupe')}</div>
      </div>
      <input type="number" min="0" step="1" class="dedupe-input" value={Math.round(cfg.dedupeMs / 1000)}
        onchange={(e) => setDedupeSeconds(Number((e.target as HTMLInputElement).value))} />
    </div>
  {/if}

  <!-- Update check -->
  <div class="set" style="border:none">
    <div class="grow">
      <div class="label">{$t('update.checkNow')}</div>
      <div class="desc">v{currentVersion}</div>
    </div>
    <button class="btn" disabled={DEMO || checkingUpdate} title={DEMO ? $t('demo.disabled') : undefined} onclick={checkNow}>
      {checkingUpdate ? $t('update.checking') : $t('update.checkNow')}
    </button>
  </div>
</div>
{#if showDevices}
  <DeviceManager {conn} prefill={devicesPrefill} onClose={() => { showDevices = false; devicesPrefill = ""; }} />
{/if}
{#if showGuide}
  <OperationGuide onClose={() => (showGuide = false)} />
{/if}
</div>

<style>
  .stg-scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
  .stg { padding: 4px 10px 10px; color: var(--text); }
  /* 左标签 + 右控件的行式布局（原为上下堆叠，纵向过长） */
  .set {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 8px 2px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  /* Stacked variant: label on top, control below (theme picker). */
  .set.col { flex-direction: column; align-items: stretch; gap: 8px; }
  .grow { flex: 1; min-width: 0; }
  .label { font-size: 13px; }
  .desc { font-size: 10.5px; color: var(--dim); margin-top: 2px; line-height: 1.4; }

  /* ---- Theme picker ---- */
  .themes {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 4px;
    background: var(--seg-bg);
  }
  .theme {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 40px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font-size: 12.5px;
    text-align: left;
    flex: 1;
    min-width: 0;
  }
  /* Custom themes carry a delete button, so the row is a flex wrapper and the
     selected-state background moves onto it — otherwise the highlight would
     stop short of the × and read as a separate control. */
  .trow { display: flex; align-items: center; border-radius: var(--radius-sm); }
  .trow.on, .theme.on {
    background: var(--seg-active-bg);
    box-shadow: var(--seg-active-ring), var(--seg-shadow);
  }
  .trow.on .theme { background: transparent; box-shadow: none; }
  .theme:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .trow.on .tick { border-color: var(--accent); }
  .trow.on .tick::after {
    content: "";
    position: absolute; inset: 2.5px;
    border-radius: 50%;
    background: var(--accent);
  }
  .cbadge {
    font-style: normal;
    font-size: 9px;
    color: var(--dim);
    border: 1px solid var(--line-strong);
    border-radius: 3px;
    padding: 0 3px;
    margin-left: 5px;
    vertical-align: 1px;
  }
  .tdel {
    flex: 0 0 auto;
    background: transparent;
    color: var(--dim);
    border: 0;
    font-size: 15px;
    line-height: 1;
    padding: 8px 9px;
    border-radius: var(--radius-sm);
  }
  .tdel:active { color: var(--red); background: var(--red-soft); }
  .tnote { color: var(--dim); font-size: 10.5px; line-height: 1.5; margin: 6px 2px 0; }
  .tnote.warn { color: var(--amber); }
  .tskips {
    list-style: none;
    margin: 3px 2px 0;
    color: var(--dim);
    font-size: 10px;
    line-height: 1.6;
    word-break: break-all;
  }
  .timport-head { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .tmsg { font-size: 10.5px; color: var(--red); flex: 1; min-width: 0; }
  .tmsg.ok { color: var(--ok); }
  .timport {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--panel2);
    padding: 10px;
    border-radius: var(--radius-lg);
    margin: 8px 2px 0;
    border: 1px solid var(--line);
  }
  .timport input, .timport textarea {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 7px;
    font-size: 0.78rem;
    font-family: inherit;
    outline: none;
    resize: none;
  }
  .timport textarea { font-family: var(--font-mono); font-size: 0.7rem; }
  .timport input:focus, .timport textarea:focus { border-color: var(--accent); }
  /* Radio dot: filled ring when picked. Colour is the only cue in the swatch
     row, so the dot carries the state redundantly (not colour-only). */
  .tick {
    flex: 0 0 auto;
    width: 13px; height: 13px;
    border-radius: 50%;
    border: 1.5px solid var(--line-strong);
    position: relative;
  }
  .theme.on .tick { border-color: var(--accent); }
  .theme.on .tick::after {
    content: "";
    position: absolute; inset: 2.5px;
    border-radius: 50%;
    background: var(--accent);
  }
  .tname { flex: 1; min-width: 0; }
  .tname s { display: block; text-decoration: none; font-size: 10px; color: var(--dim); margin-top: 1px; }
  /* 字体预览。刻意不跟随 --font-mono：每行要展示的是**它自己那套**。 */
  .fprev {
    margin-left: auto;
    font-size: 0.72rem;
    color: var(--dim);
    white-space: nowrap;
    letter-spacing: 0.02em;
  }
  .sw { flex: 0 0 auto; display: flex; gap: 2px; }
  .sw i {
    width: 13px; height: 18px;
    border-radius: 2px;
    /* Neutral hairline so both near-black and near-white swatches stay legible
       against whichever theme is currently painting the panel. */
    box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.35);
  }
  .tag {
    flex: 0 0 auto;
    font-size: 9.5px;
    color: var(--dimmer);
    min-width: 1.6em;
    text-align: right;
  }
  .val { font-size: 11px; color: var(--dim); min-width: 2.4em; text-align: right; font-family: var(--font-mono); }
  input[type="range"] { width: 104px; accent-color: var(--accent); }
  .seg {
    display: flex;
    gap: 2px;
    background: var(--seg-bg);
    border: 1px solid var(--seg-line);
    border-radius: 7px;
    padding: 3px;
    flex: 0 0 auto;
  }
  .seg button {
    background: transparent;
    border: 0;
    color: var(--dim);
    padding: 5px 10px;
    font-size: 11.5px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }
  .seg button.on {
    background: var(--seg-active-bg);
    color: var(--seg-active-text);
    font-weight: 600;
    box-shadow: var(--seg-active-ring), var(--seg-shadow);
  }
  /* 次操作：透明底 + 描边（实心留给真正的主操作） */
  .btn {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .btn:active { background: var(--panel2); }
  .btn:disabled { opacity: 0.5; cursor: default; }

  /* Notifications */
  .notify-head {
    width: 100%;
    background: transparent;
    border: 0;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .notify-head .label { color: var(--accent); font-weight: 600; }
  .chev { color: var(--dim); font-size: 0.8rem; }
  .err { color: var(--red); font-size: 11px; margin-top: 3px; }
  .nt-hint { color: var(--dim); font-size: 0.66rem; margin-top: 6px; line-height: 1.5; }
  /* 分区标题走共同设计语言：mono 大写小标题 */
  .nsub {
    color: var(--dimmer);
    font-family: var(--font-mono);
    font-size: 0.6rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 14px 2px 6px;
  }
  .webhook-head { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; }
  .add-btn {
    background: var(--primary-bg);
    color: var(--primary-text);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 5px 11px;
    font-size: 0.72rem;
    font-weight: 600;
  }
  .wh-form, .wh-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--panel2);
    padding: 10px;
    border-radius: var(--radius-lg);
    margin: 8px 4px;
    border: 1px solid var(--line);
  }
  .wh-form input, .wh-form select, .wh-form textarea,
  .wh-row input, .wh-row select, .wh-row textarea {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 7px;
    font-size: 0.78rem;
    font-family: inherit;
    outline: none;
  }
  .wh-form input:focus, .wh-form select:focus, .wh-form textarea:focus,
  .wh-row input:focus, .wh-row select:focus, .wh-row textarea:focus { border-color: var(--accent); }
  .wh-form textarea, .wh-tpl { resize: none; }
  .wh-line1 { display: flex; gap: 6px; align-items: center; }
  .wh-name { flex: 1; min-width: 0; }
  .save {
    background: var(--primary-bg);
    color: var(--primary-text);
    border: 0;
    border-radius: var(--radius-md);
    padding: 7px;
    font-weight: 600;
  }
  .del {
    background: transparent;
    color: var(--red);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 4px 9px;
    font-size: 0.9rem;
  }
  .wh-actions { display: flex; align-items: center; gap: 8px; }
  .wh-test-msg { font-size: 0.68rem; color: var(--red); }
  .wh-test-msg.ok { color: var(--ok); }
  .wh-empty { color: var(--dim); font-size: 0.72rem; text-align: center; padding: 14px 0; }
  .dedupe-input {
    width: 70px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 6px;
    font-size: 13px;
  }
</style>
