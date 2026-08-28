// Package the agent into single-file binaries. Order: build the frontend ->
// regenerate the embedded manifest -> compile one binary per target ->
// sign the darwin binaries with the stable self-signed identity (when the
// cert exists on this machine) -> restore the committed stub.
import { $ } from "bun";
import { join } from "node:path";

const AGENT = join(import.meta.dir, "..");
const APP = join(AGENT, "../app");
const OUT = join(AGENT, "dist");

// Git short SHA baked into AGENT_VERSION (version.ts) — see that file for why
// every build must carry one. Empty (plain semver) when git is unavailable
// (e.g. building from a tarball); the vite build in app/ falls back the same way.
const SHA = (await $`git rev-parse --short HEAD`.nothrow().text()).trim();
if (!SHA) console.log("[build:bin] WARNING: git short SHA unavailable — version stays plain semver (SW bucket will not rotate)");

// Required targets; darwin-x64 optional — drop it if you don't ship Intel macs.
//
// linux-x64 uses Bun's `-baseline` variant on purpose. The default x64 target
// emits AVX2, which any pre-Haswell CPU lacks — a very common VPS situation
// (e.g. Xeon E5 v1/v2, still widely rented). Those machines die with
// "Illegal instruction (core dumped)" the moment the binary starts, with
// nothing in the output pointing at the cause. Baseline only needs SSE4.2.
//
// The output FILENAME stays `pocketshell-agent-linux-x64`: OTA resolves release
// assets from platform+arch (update-core.ts `assetNameForPlatform`), so a
// separate `-baseline` asset would make old-CPU machines re-download the
// crashing AVX2 build on every auto-update. One asset that runs everywhere is
// worth more than the SIMD headroom — this process mostly shuttles PTY bytes.
const TARGETS = ["bun-linux-x64-baseline", "bun-linux-arm64", "bun-darwin-arm64", "bun-darwin-x64"];

/** Release asset name for a build target. Baseline ships under the plain x64 name (see above). */
function outNameFor(target: string): string {
  return `pocketshell-agent-${target.replace("bun-", "").replace("-baseline", "")}`;
}

// Stable self-signed identity, same one update-local.sh uses (one-time setup:
// docs/deploy-info/update-runbook.md). TCC grants bind to the designated
// requirement; ad-hoc rebuilds change cdhash every time, so macOS treats each
// rebuild as a new app and drops prior grants. Fixed cert + fixed identifier
// keep the DR stable across rebuilds.
const SIGN_IDENTITY = "PocketShell Self-Signed";
const SIGN_IDENTIFIER = "com.myt.pocketshell";

async function findSigningIdentity(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const out = await $`security find-identity -v -p codesigning`.nothrow().text();
  return out.includes(SIGN_IDENTITY);
}

await $`cd ${APP} && bun run build`;
await $`cd ${AGENT} && bun run gen:embedded`;

// POCKETSHELL_BUILD_SIGN=0 forces ad-hoc darwin binaries even when the identity
// exists. This is correct for PUBLIC RELEASE builds (scripts/release.sh sets it):
// the self-signed cert lives only in this machine's keychain, so signing with it
// gives end users nothing (their macOS doesn't trust it) and OTA re-signs on
// their own machine anyway — while a background `codesign` here would block on
// the keychain private-key auth prompt. Local/prod deploys (update-local.sh)
// sign independently and don't go through this path.
const signOptOut = process.env.POCKETSHELL_BUILD_SIGN === "0";
const canSign = !signOptOut && (await findSigningIdentity());
if (signOptOut) {
  console.log(`[build:bin] POCKETSHELL_BUILD_SIGN=0 — darwin binaries stay ad-hoc (public release: end users don't have this cert; OTA re-signs on their machine).`);
} else if (!canSign) {
  console.log(`[build:bin] WARNING: "${SIGN_IDENTITY}" not found (or not macOS); darwin binaries stay ad-hoc signed (TCC grants won't persist).`);
}

for (const t of TARGETS) {
  const outfile = join(OUT, outNameFor(t));
  console.log(`[build:bin] compiling ${t} -> ${outfile}`);
  await $`cd ${AGENT} && bun build --compile --target=${t} src/server.ts --outfile ${outfile} ${SHA ? ["--define", `process.env.PS_BUILD_SHA=${JSON.stringify(SHA)}`] : []}`;
  if (canSign && t.startsWith("bun-darwin")) {
    await $`codesign --force --sign ${SIGN_IDENTITY} --identifier ${SIGN_IDENTIFIER} ${outfile}`;
    console.log(`[build:bin] signed ${t} (identifier ${SIGN_IDENTIFIER})`);
  }
}

// Keep the repo clean: the generated manifest must not be committed.
await $`cd ${AGENT} && git checkout -- src/embedded-manifest.ts`;
console.log(`[build:bin] done — binaries in ${OUT}`);
