// Package the agent into single-file binaries. Order: build the frontend ->
// regenerate the embedded manifest -> compile one binary per target ->
// restore the committed stub so the working tree stays clean.
import { $ } from "bun";
import { join } from "node:path";

const AGENT = join(import.meta.dir, "..");
const APP = join(AGENT, "../app");
const OUT = join(AGENT, "dist");

// Required targets; darwin-x64 optional — drop it if you don't ship Intel macs.
const TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-arm64", "bun-darwin-x64"];

await $`cd ${APP} && bun run build`;
await $`cd ${AGENT} && bun run gen:embedded`;

for (const t of TARGETS) {
  const outfile = join(OUT, `pocketshell-agent-${t.replace("bun-", "")}`);
  console.log(`[build:bin] compiling ${t} -> ${outfile}`);
  await $`cd ${AGENT} && bun build --compile --target=${t} src/server.ts --outfile ${outfile}`;
}

// Keep the repo clean: the generated manifest must not be committed.
await $`cd ${AGENT} && git checkout -- src/embedded-manifest.ts`;
console.log(`[build:bin] done — binaries in ${OUT}`);
