// Post-build: emit .br + .gz siblings for sizable text assets in dist/, so the
// agent can serve precompressed variants (see agent/src/static-serve.ts).
// gen-embedded.ts embeds them alongside the originals.
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

const MIN_BYTES = 10 * 1024;
const TEXT_EXT = new Set([".js", ".css", ".html", ".svg", ".webmanifest", ".json"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) yield* walk(abs);
    else yield abs;
  }
}

const distDir = join(import.meta.dir, "../dist");
let count = 0;
for (const file of walk(distDir)) {
  const ext = extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext)) continue;
  const src = readFileSync(file);
  if (src.length < MIN_BYTES) continue;
  writeFileSync(
    `${file}.br`,
    brotliCompressSync(src, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }),
  );
  writeFileSync(`${file}.gz`, gzipSync(src, { level: 9 }));
  count++;
}
console.log(`[compress-dist] precompressed ${count} file(s) under ${distDir}`);
