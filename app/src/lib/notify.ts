// Pure helpers for the notification feature (unit-tested; no DOM/network).
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function sessionFromUrl(search: string): string | null {
  const v = new URLSearchParams(search).get("session");
  return v && v.length > 0 ? v : null;
}
