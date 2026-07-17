// Package the agent into single-file binaries. Order: build the frontend ->
// regenerate the embedded manifest -> compile one binary per target ->
// sign the darwin binaries with the stable self-signed identity (when the
// cert exists on this machine) -> restore the committed stub.
import { $ } from "bun";
import { join } from "node:path";

const AGENT = join(import.meta.dir, "..");
const APP = join(AGENT, "../app");
const OUT = join(AGENT, "dist");

// Required targets; darwin-x64 optional — drop it if you don't ship Intel macs.
const TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-arm64", "bun-darwin-x64"];

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

const canSign = await findSigningIdentity();
if (!canSign) {
  console.log(`[build:bin] WARNING: "${SIGN_IDENTITY}" not found (or not macOS); darwin binaries stay ad-hoc signed (TCC grants won't persist).`);
}

for (const t of TARGETS) {
  const outfile = join(OUT, `pocketshell-agent-${t.replace("bun-", "")}`);
  console.log(`[build:bin] compiling ${t} -> ${outfile}`);
  await $`cd ${AGENT} && bun build --compile --target=${t} src/server.ts --outfile ${outfile}`;
  if (canSign && t.startsWith("bun-darwin")) {
    await $`codesign --force --sign ${SIGN_IDENTITY} --identifier ${SIGN_IDENTIFIER} ${outfile}`;
    console.log(`[build:bin] signed ${t} (identifier ${SIGN_IDENTIFIER})`);
  }
}

// Keep the repo clean: the generated manifest must not be committed.
await $`cd ${AGENT} && git checkout -- src/embedded-manifest.ts`;
console.log(`[build:bin] done — binaries in ${OUT}`);
