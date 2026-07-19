// Pure helpers for OTA update decisions — no I/O, fully unit-testable.

function parts(v: string): [number, number, number] {
  const s = v.startsWith("v") ? v.slice(1) : v;
  const [a, b, c] = s.split(".").map((n) => parseInt(n, 10) || 0);
  return [a, b, c];
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

export function hasUpdate(current: string, latest: string): boolean {
  return compareSemver(current, latest) === -1;
}

const ARCH_MAP: Record<string, string> = { x64: "x64", arm64: "arm64" };
const OS_MAP: Record<string, string> = { linux: "linux", darwin: "darwin" };

export function assetNameForPlatform(platform: string, arch: string): string | null {
  const os = OS_MAP[platform];
  const a = ARCH_MAP[arch];
  if (!os || !a) return null;
  return `pocketshell-agent-${os}-${a}`;
}

export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]+)\s+\.?\/?(.+)$/);
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}
