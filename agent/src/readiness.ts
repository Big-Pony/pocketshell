// First-run readiness output. Pure (returns lines) so it is unit-tested; the
// import.meta.main block in server.ts prints them. Audience includes
// non-technical users, so wording is plain.
export function isNonLocalBind(host: string): boolean {
  return !["127.0.0.1", "::1", "localhost"].includes(host);
}

export interface ReadinessInput {
  advertise: string;
  appUrl: string;
  pubKeyB64: string;
  pairingString?: string;
  pairingTtlSec?: number;
  advertiseExplicit: boolean;
  bindNonLocal: boolean;
}

export function buildReadiness(i: ReadinessInput): string[] {
  const lines: string[] = [];
  lines.push(`[pocketshell] 📱 Open this on your phone to get the app:  ${i.appUrl}`);
  lines.push(`[pocketshell] advertise address: ${i.advertise}`);
  lines.push(`[pocketshell] agent public key: ${i.pubKeyB64}`);
  if (i.pairingString) {
    lines.push(`[pocketshell] pairing string (paste into the app to connect):`);
    lines.push(`  ${i.pairingString}`);
    if (i.pairingTtlSec) lines.push(`[pocketshell] pairing code valid for ~${i.pairingTtlSec}s`);
  }
  if (!i.advertiseExplicit && i.bindNonLocal) {
    lines.push(
      `[pocketshell] NOTE: POCKETSHELL_ADVERTISE is not set. For your phone to reach this ` +
      `agent, set POCKETSHELL_ADVERTISE=wss://<your-domain>, or follow the README for ` +
      `Cloudflare Tunnel / tailscale.`,
    );
  }
  return lines;
}
