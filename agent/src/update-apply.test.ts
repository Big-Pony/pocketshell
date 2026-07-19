import { test, expect } from "bun:test";
import { downloadAndVerify } from "./update-apply";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Build a minimal gzip tarball in memory with one file, return {bytes, sha}.
// Use Bun's tar? Simpler: shell out to tar in the test to craft a real archive.
import { $ } from "bun";

async function makeArchive(dir: string, binName: string): Promise<{ buf: Uint8Array; sha: string }> {
  await Bun.write(join(dir, binName), "#!/bin/sh\necho stub\n");
  await $`chmod +x ${join(dir, binName)}`;
  await $`tar -czf ${join(dir, binName + ".tar.gz")} -C ${dir} ${binName}`;
  const buf = new Uint8Array(await Bun.file(join(dir, binName + ".tar.gz")).arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  return { buf, sha };
}

test("downloadAndVerify extracts binary when checksum matches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psa-"));
  const plat = "linux-x64";
  const binName = `pocketshell-agent-${plat}`;
  const { buf, sha } = await makeArchive(dir, binName);
  const sums = `${sha}  ./${binName}.tar.gz\n`;

  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith("SHA256SUMS.txt")) return new Response(sums);
    if (String(url).endsWith(`${binName}.tar.gz`)) return new Response(buf);
    throw new Error("unexpected url " + url);
  }) as unknown as typeof fetch;

  const phases: string[] = [];
  const { binaryPath } = await downloadAndVerify({
    repo: "x/y", tag: "v0.4.0", keyDir: dir, platform: "linux", arch: "x64",
    fetchImpl, onPhase: (p) => phases.push(p),
  });
  expect(binaryPath.endsWith(binName)).toBe(true);
  expect(await Bun.file(binaryPath).text()).toContain("stub");
  expect(phases).toContain("downloading");
  expect(phases).toContain("verifying");
});

test("downloadAndVerify throws on checksum mismatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psa2-"));
  const plat = "linux-x64";
  const binName = `pocketshell-agent-${plat}`;
  const { buf } = await makeArchive(dir, binName);
  const sums = `${"0".repeat(64)}  ./${binName}.tar.gz\n`;
  const fetchImpl = (async (url: string) =>
    String(url).endsWith("SHA256SUMS.txt") ? new Response(sums) : new Response(buf)
  ) as unknown as typeof fetch;

  await expect(downloadAndVerify({
    repo: "x/y", tag: "v0.4.0", keyDir: dir, platform: "linux", arch: "x64",
    fetchImpl, onPhase: () => {},
  })).rejects.toThrow(/checksum/i);
});
