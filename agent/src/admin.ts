// Server-local admin page (needs 9): plain HTTP, localhost-only. Pure helpers
// (local-IP gate + device-row view + the embedded page) live here so they are
// unit-testable; server.ts wires them to config/conns.
import type { DeviceRecord } from "./device-registry";

export function isLocalAddr(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export interface AdminDeviceRow {
  pubKey: string; name: string; addedAt: string; lastSeen: string | null; online: boolean; ip: string;
}

export function deviceRows(records: DeviceRecord[], onlineIpByPub: Map<string, string>): AdminDeviceRow[] {
  return records.map((d) => {
    const live = onlineIpByPub.get(d.pubKey);
    return {
      pubKey: d.pubKey,
      name: d.name,
      addedAt: d.addedAt,
      lastSeen: d.lastSeen,
      online: live !== undefined,
      ip: live ?? d.lastIp ?? "",
    };
  });
}

export const ADMIN_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PocketShell 本地管理</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #14181d; color: #c8d3dc; margin: 0; padding: 16px; }
  h1 { font-size: 18px; display: inline-block; margin-right: 10px; }
  a.lang { color: #46d0b4; font-size: 12px; text-decoration: none; }
  button { background: #46d0b4; color: #08221c; border: 0; border-radius: 8px; padding: 8px 14px; font-size: 14px; }
  button.ghost { background: #263039; color: #c8d3dc; }
  .pair { background: #1c2530; border: 1px solid #2a3540; border-radius: 10px; padding: 12px; margin: 12px 0; }
  .pair input { width: 100%; box-sizing: border-box; background: #0f1418; color: #c8d3dc; border: 1px solid #2a3540; border-radius: 6px; padding: 8px; font-family: monospace; font-size: 12px; margin: 8px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #263039; word-break: break-all; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #4a5560; }
  .dot.on { background: #46d0b4; }
  .muted { color: #7c8a97; font-size: 12px; }
</style>
</head>
<body>
<h1 data-i18n="title">PocketShell 本地管理</h1><a class="lang" id="langToggle" href="#">EN / 中</a>
<div class="pair">
  <button id="gen" data-i18n="gen">生成配对密钥（5 分钟有效）</button>
  <div id="pairOut" style="display:none">
    <div class="muted" data-i18n="pairHint">把下面的配对串粘贴到手机 App 完成配对：</div>
    <input id="pairStr" readonly />
    <button class="ghost" id="copy" data-i18n="copy">复制</button>
    <span id="copied" class="muted"></span>
  </div>
</div>
<h2 style="font-size:15px" data-i18n="devices">已配对设备</h2>
<table><thead><tr><th data-i18n="status">状态</th><th data-i18n="name">名称</th><th data-i18n="ip">访问 IP</th><th data-i18n="recent">最近</th><th></th></tr></thead>
<tbody id="rows"><tr><td colspan="5" class="muted" data-i18n="loading">加载中…</td></tr></tbody></table>
<script>
// Bilingual page: ?lang=zh|en wins and is remembered, then localStorage, then
// the browser language (zh* -> zh, else en). Static markup above is Chinese;
// when English resolves, every [data-i18n] element is swapped to en below.
var I18N = {
  zh: { title: 'PocketShell 本地管理', gen: '生成配对密钥（5 分钟有效）', pairHint: '把下面的配对串粘贴到手机 App 完成配对：', copy: '复制', copied: '已复制', devices: '已配对设备', status: '状态', name: '名称', ip: '访问 IP', recent: '最近', loading: '加载中…', empty: '暂无配对设备', del: '删除' },
  en: { title: 'PocketShell Admin', gen: 'Generate pairing key (valid 5 min)', pairHint: 'Paste this pairing string into the mobile app:', copy: 'Copy', copied: 'Copied', devices: 'Paired devices', status: 'Status', name: 'Name', ip: 'IP', recent: 'Last seen', loading: 'Loading…', empty: 'No paired devices', del: 'Remove' }
};
function pickLang() {
  var q = new URLSearchParams(location.search).get('lang');
  if (q === 'zh' || q === 'en') { try { localStorage.setItem('ps.admin.lang', q); } catch (e) {} return q; }
  try { var s = localStorage.getItem('ps.admin.lang'); if (s === 'zh' || s === 'en') return s; } catch (e) {}
  return (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
}
var LANG = pickLang();
var L = I18N[LANG];
document.documentElement.lang = LANG === 'zh' ? 'zh' : 'en';
document.title = L.title;
document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = L[el.dataset.i18n]; });
document.getElementById('langToggle').onclick = function (e) {
  e.preventDefault();
  var next = LANG === 'zh' ? 'en' : 'zh';
  try { localStorage.setItem('ps.admin.lang', next); } catch (err) {}
  // Navigate with an explicit ?lang= so a stale query param can't win on reload.
  location.search = '?lang=' + next;
};
// Escape device-supplied strings (name is chosen by the pairing device) before
// they touch innerHTML, so a crafted device name can't inject script/markup.
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
async function j(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(await r.text()); return r.json(); }
document.getElementById('gen').onclick = async () => {
  const r = await j('/admin-api/pair', { method: 'POST' });
  document.getElementById('pairStr').value = r.pairString;
  document.getElementById('pairOut').style.display = 'block';
};
document.getElementById('copy').onclick = async () => {
  const el = document.getElementById('pairStr');
  el.select();
  try { await navigator.clipboard.writeText(el.value); } catch (e) { document.execCommand('copy'); }
  document.getElementById('copied').textContent = L.copied;
};
async function load() {
  const rows = await j('/admin-api/devices');
  const tb = document.getElementById('rows');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">' + L.empty + '</td></tr>'; return; }
  tb.innerHTML = rows.map(function (d) {
    return '<tr><td><span class="dot ' + (d.online ? 'on' : '') + '"></span></td>' +
      '<td>' + esc(d.name) + '</td><td>' + (d.ip ? esc(d.ip) : '—') + '</td>' +
      '<td class="muted">' + (d.lastSeen ? esc(d.lastSeen) : '—') + '</td>' +
      '<td><button class="ghost" data-pub="' + esc(d.pubKey) + '">' + L.del + '</button></td></tr>';
  }).join('');
  tb.querySelectorAll('button[data-pub]').forEach(function (b) {
    b.onclick = async function () {
      await j('/admin-api/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pubKey: b.dataset.pub }) });
      load();
    };
  });
}
load();
</script>
</body>
</html>`;
