// B6 pairing — parse the pasted pairing string produced by the agent console.
// Format: "pocketshell-pair:" + base64url(JSON{v:1,pub,addr,code}).
import { tr } from "./i18n";

export interface PairingInfo { pub: string; addr: string; code: string; }

const PREFIX = "pocketshell-pair:";

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return atob(b64);
}

export function parsePairingString(input: string): { ok: true; value: PairingInfo } | { ok: false; error: string } {
  const s = input.trim();
  if (!s.startsWith(PREFIX)) return { ok: false, error: tr("errors.pairing.prefix") };
  let json: any;
  try { json = JSON.parse(b64urlDecode(s.slice(PREFIX.length))); }
  catch { return { ok: false, error: tr("errors.pairing.decode") }; }
  if (json?.v !== 1) return { ok: false, error: tr("errors.pairing.version") };
  const { pub, addr, code } = json;
  if (typeof pub !== "string" || typeof addr !== "string" || typeof code !== "string" || !pub || !addr || !code) {
    return { ok: false, error: tr("errors.pairing.fields") };
  }
  return { ok: true, value: { pub, addr, code } };
}
