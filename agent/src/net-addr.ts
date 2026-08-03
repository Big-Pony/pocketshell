// Source-address helpers.
//
// Previously lived in admin.ts, which was deleted along with the admin page
// (see docs/项目信息.md §九). The remaining caller is POST /internal/notify.
//
// ⚠️ A loopback source address is NOT an identity. `srv.requestIP()` reports
// the LAST HOP, and every same-host reverse proxy — Caddy, Nginx, Cloudflare
// Tunnel, frp, i.e. all four deployments the docs recommend — connects from
// 127.0.0.1. So this returns true for public internet traffic on any proxied
// box. The admin page trusted it as its only credential and was therefore
// world-open (VULN-001, 2026-08-03 audit).
//
// Use it only as a second layer behind a real credential. /internal/notify is
// correct because it also requires a bearer token; the loopback check just
// narrows the attack surface, it does not create it.
export function isLocalAddr(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
