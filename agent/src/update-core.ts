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
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\.?\/?(.+)$/);
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

/**
 * OTA smoke check 的版本比对（server.ts runApply 用）：新二进制 `--version`
 * 的输出必须匹配 release 的 semver。
 *
 * 接受两种形态：
 *   - `"1.21.2"`        纯 semver（无 SHA 注入的构建）
 *   - `"1.21.2-c1752ba"` semver + `-<构建SHA>` 后缀（version.ts：自 2026-08-28
 *     起 release.sh 编译时注入 git 短 SHA，SW 按版本串分缓存桶）
 *
 * 严格相等曾把带 SHA 的合法发布二进制误判为「版本不对」导致更新失败
 * （2026-08-28 v1.21.2 实测）。后缀边界必须带 `-`：`1.21.20` 不能匹配
 * `1.21.2`。
 */
export function versionMatchesRelease(got: string, latest: string): boolean {
  const g = got.trim();
  return g === latest || g.startsWith(`${latest}-`);
}
