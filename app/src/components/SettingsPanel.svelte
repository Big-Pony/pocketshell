<!-- app/src/components/SettingsPanel.svelte -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { tr } from "../lib/i18n";
  import type { Connection } from "../lib/connection";
  import type { Settings } from "../lib/settings";
  import { urlBase64ToUint8Array, defaultNotifyConfig, type NotifyConfig, type WebhookCfg, type WebhookKind } from "../lib/notify";
  import DeviceManager from "./DeviceManager.svelte";
  import OperationGuide from "./OperationGuide.svelte";

  let { conn, settings, onChange, currentVersion, onCheckUpdate }: {
    conn: Connection; settings: Settings; onChange: (s: Settings) => void;
    currentVersion: string; onCheckUpdate: () => Promise<void>;
  } = $props();

  function update<K extends keyof Settings>(k: K, v: Settings[K]) {
    onChange({ ...settings, [k]: v });
  }

  let showDevices = $state(false);
  let showGuide = $state(false);
  let checkingUpdate = $state(false);
  async function checkNow() {
    checkingUpdate = true;
    try { await onCheckUpdate(); } finally { checkingUpdate = false; }
  }

  // ---- Notifications ----
  // Section is collapsed by default (and every channel defaults off in
  // NotifyConfig itself) — nothing here touches the user's environment until
  // they explicitly flip a toggle.
  const TOOLS: Array<"claude" | "codex" | "opencode"> = ["claude", "codex", "opencode"];
  const WEBHOOK_KINDS: WebhookKind[] = ["wecom", "feishu", "slack", "discord", "custom"];
  const WIRE_REASONS = new Set(["parse_error", "write_error", "read_error", "conflict", "opencode_not_found"]);

  let notifyOpen = $state(false);
  let notifyLoaded = $state(false);
  let cfg = $state<NotifyConfig>(defaultNotifyConfig());
  let wireError = $state<Record<string, string | null>>({ claude: null, codex: null, opencode: null });
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

  function reasonText(reason?: string, detail?: string): string {
    if (reason && WIRE_REASONS.has(reason)) return tr(`notify.reason.${reason}`);
    return detail || tr("notify.wireFailed");
  }

  async function persistCfg() { await conn.notifySetConfig(cfg); }

  async function toggleTool(tool: "claude" | "codex" | "opencode", on: boolean) {
    const r = on ? await conn.notifyWire(tool) : await conn.notifyUnwire(tool);
    if (!r.ok) { wireError = { ...wireError, [tool]: reasonText(r.reason, r.detail) }; return; }
    wireError = { ...wireError, [tool]: null };
    cfg = { ...cfg, tools: { ...cfg.tools, [tool]: on } };
    await persistCfg();
  }

  async function toggleWebPush(on: boolean) {
    if (!on) {
      await conn.notifyUnsubscribe();
      cfg = { ...cfg, webPush: false };
      await persistCfg();
      webPushError = null;
      return;
    }
    webPushError = null;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { webPushError = tr("notify.permDenied"); return; }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await conn.notifyGetVapidKey();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await conn.notifySubscribe(sub.toJSON());
      cfg = { ...cfg, webPush: true };
      await persistCfg();
    } catch (e) {
      webPushError = e instanceof Error ? e.message : String(e);
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
</script>

<div class="stg-scroll">
<div class="stg">
  <!-- Theme -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('settings.theme.label')}</div>
      <div class="desc">{$t('settings.theme.desc')}</div>
    </div>
    <div class="seg">
      <button class:on={settings.theme === "dark"} onclick={() => update("theme", "dark")}>{$t('settings.theme.dark')}</button>
      <button class:on={settings.theme === "light"} onclick={() => update("theme", "light")}>{$t('settings.theme.light')}</button>
      <button class:on={settings.theme === "system"} onclick={() => update("theme", "system")}>{$t('settings.theme.system')}</button>
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
    <button class="btn" onclick={() => (showDevices = !showDevices)}>
      {showDevices ? $t('settings.devices.close') : $t('settings.devices.manage')}
    </button>
  </div>

  <!-- Operation guide -->
  <div class="set">
    <div class="grow">
      <div class="label">{$t('guide.title')}</div>
      <div class="desc">{$t('guide.desc')}</div>
    </div>
    <button class="btn" onclick={() => (showGuide = true)}>{$t('guide.open')}</button>
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

    <div class="nsub">{$t('notify.delivery')}</div>
    <div class="set">
      <div class="grow">
        <div class="label">{$t('notify.webpush.label')}</div>
        {#if showIosHint}<div class="desc">{$t('notify.webpush.iosHint')}</div>{/if}
        {#if webPushError}<div class="err">{webPushError}</div>{/if}
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
    <button class="btn" disabled={checkingUpdate} onclick={checkNow}>
      {checkingUpdate ? $t('update.checking') : $t('update.checkNow')}
    </button>
  </div>
</div>
{#if showDevices}
  <DeviceManager {conn} onClose={() => (showDevices = false)} />
{/if}
{#if showGuide}
  <OperationGuide onClose={() => (showGuide = false)} />
{/if}
</div>

<style>
  .stg-scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
  .stg { padding: 8px; color: var(--text); }
  .set {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 4px;
    border-bottom: 1px solid var(--line);
    font-size: 14px;
  }
  .grow { flex: 1; }
  .label { font-size: 14px; }
  .desc { font-size: 11px; color: var(--dim); margin-top: 3px; }
  .val { font-size: 12px; color: var(--dim); min-width: 2.5em; text-align: right; }
  input[type="range"] { width: 110px; accent-color: var(--primary-bg); }
  .seg {
    display: flex;
    gap: 2px;
    background: var(--seg-bg);
    border: 1px solid var(--seg-line);
    border-radius: 999px;
    padding: 2px;
  }
  .seg button {
    background: transparent;
    border: 0;
    color: var(--dim);
    padding: 5px 12px;
    font-size: 12px;
    border-radius: 999px;
  }
  .seg button.on {
    background: var(--seg-active-bg);
    color: var(--seg-active-text);
    font-weight: 600;
    box-shadow: var(--seg-shadow);
  }
  .btn {
    background: var(--primary-bg);
    color: var(--primary-text);
    border: 0;
    border-radius: 999px;
    padding: 7px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
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
  .nsub {
    color: var(--dimmer);
    font-size: 0.66rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 14px 4px 6px;
  }
  .webhook-head { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; }
  .add-btn {
    background: var(--accent-soft);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: 999px;
    padding: 5px 12px;
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
