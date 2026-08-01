// Pure helpers for the notification feature (unit-tested; no DOM/network).
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// 浏览器订阅失败时抛的是给开发者看的英文原文（Chrome 最典型的一句
// "Registration failed - push service error"），用户看到只会一脸茫然。这里把
// 认得出的几种映射成 i18n key，认不出的返回 null 让调用方原样显示错误文本
// ——宁可露出英文原文，也不吞掉未知错误。
export function webPushErrorKey(e: unknown): string | null {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  // Chrome 要向 FCM 注册才能拿到订阅端点；国内网络够不着 fcm.googleapis.com
  // 就是这一句，与 VAPID 密钥、SW、权限都无关（实测：baidu/github 443 通、
  // fcm.googleapis.com 443 不通时必现）。
  if (msg.includes("push service error")) return "notify.webpush.err.unreachable";
  if (msg.includes("no active service worker")) return "notify.webpush.err.noWorker";
  return null;
}

// agent 侧发送失败的原因（notify.json 的 webPushLastError，经 notify.getConfig
// 回传）。与 webPushErrorKey 是两套文本：那边是浏览器的 DOMException，这边是
// Node/undici 的网络错误——服务器发不出去与手机订阅不上是两回事，提示也不同
// （这台服务器要能到 fcm.googleapis.com，与手机自己的网络无关）。
export function pushSendErrorKey(e: string | null | undefined): string | null {
  const msg = (e ?? "").toLowerCase();
  if (!msg) return null;
  if (/econnrefused|etimedout|enotfound|econnreset|ehostunreach|enetunreach|fetch failed|socket hang up/.test(msg)) {
    return "notify.webpush.err.sendUnreachable";
  }
  // 换过 vapid.json（或换了服务器）而手机上的旧订阅还在时，推送服务回 403 并
  // 在 body 里明说密钥对不上。重新订阅即可，值得区别于"网络不通"单独提示。
  if (msg.includes("vapid credentials")) return "notify.webpush.err.sendVapidMismatch";
  return null;
}

// OTA 更新后 App.svelte 会走 hardReset()，其中的 unregisterServiceWorkers()
// 连带销毁浏览器的 push 订阅——但 agent 侧 notify.json 的 webPush 仍是 true，
// push-subs.json 里那条 endpoint 也还在（注销 SW 不会让推送服务返回 410，
// sendPush 的自动清理兜不住）。结果是设置面板显示「开」而实际收不到推送，
// 用户必须手动关一次再开。启动时用这个判据静默补订阅。
//
// 三个条件缺一不可：
//
// 1. cfgWebPush —— agent 侧开着推送。
// 2. !hasBrowserSub —— 这台设备的订阅确实没了（否则无事可做）。
// 3. permission === "granted" —— **这台设备**曾经同意过通知。
//
// 第 3 条是关键，两个作用：
//
// (a) notify.json 是 agent 全局的，不是每设备一份。手机开了推送后，一台从没
//     开过推送的新设备连上来同样读到 webPush=true —— 只看前两条就会替它订阅，
//     用户从没同意过却开始收通知。Notification.permission 由浏览器每设备独立
//     持有（hardReset 也清不掉），是「这台设备是否同意过」唯一可信的本地证据。
// (b) 权限为 default 时调 subscribe() 会**弹权限框**。自愈是后台行为，绝不能
//     在用户刚连上时凭空弹窗。挡住非 granted 也就挡住了弹窗。
//
// 单向：只补不撤，绝不因为浏览器有残留订阅就把用户主动关掉的推送重新打开。
export function needsResubscribe(s: {
  cfgWebPush: boolean;
  hasBrowserSub: boolean;
  permission: NotificationPermission;
}): boolean {
  return s.cfgWebPush && !s.hasBrowserSub && s.permission === "granted";
}

export function sessionFromUrl(search: string): string | null {
  const v = new URLSearchParams(search).get("session");
  return v && v.length > 0 ? v : null;
}

// Mirrors agent/src/notify-config.ts NotifyConfig/WebhookCfg — notify.getConfig /
// notify.setConfig carry this shape over the wire as an opaque `unknown`, so the
// frontend keeps its own copy of the type instead of importing across packages.
export type WebhookKind = "wecom" | "feishu" | "slack" | "discord" | "custom";
export interface WebhookCfg {
  id: string; name: string; kind: WebhookKind; url: string;
  enabled: boolean; secret?: string; template?: string;
  method?: string; headers?: Record<string, string>; lastError?: string | null;
}
export interface NotifyConfig {
  tools: { claude: boolean; codex: boolean; opencode: boolean; kimi: boolean };
  webPush: boolean; includeSummary: boolean; dedupeMs: number; webhooks: WebhookCfg[];
  /** 上次 Web Push 发送失败的原因（agent 侧记录，成功即清空）。 */
  webPushLastError?: string | null;
  /** 需求 5：接管 Claude Code 的 statusLine 以获取上下文用量。与 tools.* 不同
   *  ——它不产生任何通知，只取数字，所以单列一个字段而不是塞进 tools。 */
  contextStatusline: boolean;
}

export function defaultNotifyConfig(): NotifyConfig {
  return { tools: { claude: false, codex: false, opencode: false, kimi: false }, webPush: false, webPushLastError: null, includeSummary: true, dedupeMs: 10000, webhooks: [], contextStatusline: false };
}
