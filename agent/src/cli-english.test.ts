// Guardrail: the install path is the one surface EVERY user must pass through,
// and README/DEPLOYMENT are English — so its user-facing output must be English
// too. Before 2026-08-16 it was entirely Chinese (94 strings): an English user
// running `curl | sh` saw 正在下载… and could not even tell whether it worked.
//
// The App has svelte-i18n with i18n.test.ts enforcing key parity; the CLI has
// no such machinery and nothing stopped the drift. This file is that stop.
//
// Scope note: only *user-facing output* is checked. Chinese comments are an
// asset (they carry the reasoning) and are explicitly allowed — the scan strips
// comments before looking. Chinese *test data* (instance names like "开发") is
// also deliberate: it covers CJK values surviving unit/plist rendering.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CJK = /[一-鿿]/;

/** Strips // line comments, block comments, and shell # comments. */
function stripComments(src: string, shell = false): string {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, "");
  if (shell) {
    // A '#' inside a quoted string is not a comment; this is a deliberate
    // over-strip — false negatives here are safe, false positives are not.
    s = s.replace(/^\s*#.*$/gm, "");
  } else {
    s = s.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
  }
  return s;
}

const FILES: Array<{ path: string; shell?: boolean }> = [
  { path: "src/cli-install.ts" },
  { path: "src/install-runner.ts" },
  { path: "../install.sh", shell: true },
];

for (const f of FILES) {
  test(`${f.path} has no Chinese in user-facing output`, () => {
    const src = readFileSync(join(import.meta.dir, "..", f.path), "utf8");
    const code = stripComments(src, f.shell);
    const offenders = code
      .split("\n")
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter((l) => CJK.test(l.line));

    expect(
      offenders.map((o) => `${f.path}:${o.no}  ${o.line}`).join("\n"),
    ).toBe("");
  });
}

test("stripComments keeps strings while dropping comments", () => {
  // Guards the guard: if stripComments over-stripped, the scan above would
  // silently pass on real violations.
  expect(stripComments('const a = "keep";\n// 丢掉\n')).toContain('"keep"');
  expect(stripComments('const a = "keep";\n// 丢掉\n')).not.toContain("丢掉");
  expect(stripComments('say "keep"\n# 丢掉\n', true)).toContain('"keep"');
  expect(stripComments('say "keep"\n# 丢掉\n', true)).not.toContain("丢掉");
});
