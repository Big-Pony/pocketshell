import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { assetNameForPlatform, parseSha256Sums } from "./update-core";

export type Phase = "downloading" | "verifying" | "signing" | "applying" | "restarting" | "error";

export interface ApplyDeps {
  repo: string;
  tag: string;
  keyDir: string;
  platform?: string;
  arch?: string;
  fetchImpl?: typeof fetch;
  onPhase: (p: Phase, extra?: { pct?: number; message?: string }) => void;
}

export async function downloadAndVerify(deps: ApplyDeps): Promise<{ binaryPath: string }> {
  const f = deps.fetchImpl ?? fetch;
  const asset = assetNameForPlatform(deps.platform ?? process.platform, deps.arch ?? process.arch);
  if (!asset) throw new Error("unsupported_platform");
  const tar = `${asset}.tar.gz`;
  const rel = `https://github.com/${deps.repo}/releases/download/${deps.tag}`;
  const outDir = join(deps.keyDir, "updates");
  mkdirSync(outDir, { recursive: true });

  deps.onPhase("downloading");
  const [tgzRes, sumRes] = await Promise.all([
    f(`${rel}/${tar}`, { headers: { "User-Agent": "pocketshell-agent" } }),
    f(`${rel}/SHA256SUMS.txt`, { headers: { "User-Agent": "pocketshell-agent" } }),
  ]);
  if (!tgzRes.ok || !sumRes.ok) throw new Error("download failed");
  const tgz = new Uint8Array(await tgzRes.arrayBuffer());
  const sums = parseSha256Sums(await sumRes.text());

  deps.onPhase("verifying");
  const want = sums.get(tar);
  const got = createHash("sha256").update(tgz).digest("hex");
  if (!want || want !== got) throw new Error(`checksum mismatch for ${tar}`);

  const tgzPath = join(outDir, tar);
  await Bun.write(tgzPath, tgz);
  // Extract only the binary (archive also carries LICENSE).
  await $`tar -xzf ${tgzPath} -C ${outDir} ${asset}`.quiet();
  const binaryPath = join(outDir, asset);
  chmodSync(binaryPath, 0o755);
  return { binaryPath };
}
