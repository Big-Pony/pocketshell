import { test, expect } from "bun:test";
import { crc32, buildZip } from "./zip-writer";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("crc32 matches the standard check vector", () => {
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  expect(crc32(new Uint8Array(0))).toBe(0);
});

test("buildZip sets the UTF-8 (EFS) general-purpose bit-11 in the local header", () => {
  const zip = buildZip([{ name: "中文/文件.txt", data: new TextEncoder().encode("hi") }]);
  // Local file header: bytes 0-3 = PK\x03\x04 signature, bytes 6-7 = GP flag (LE).
  expect(zip[0]).toBe(0x50); expect(zip[1]).toBe(0x4b);
  expect(zip[2]).toBe(0x03); expect(zip[3]).toBe(0x04);
  expect(zip[6]).toBe(0x00); expect(zip[7]).toBe(0x08); // 0x0800 = bit-11
});

// Uses bsdtar (libarchive), not /usr/bin/unzip: this machine's unzip is
// Apple's modified Info-Zip 6.00 (2009) build, which does NOT honor the
// general purpose bit-11 (UTF-8/EFS) flag on extraction — it mojibakes the
// CJK name regardless (confirmed: `python3 -c zipfile` on the same archive
// reports flag_bits=0x800 and decodes the name correctly). bsdtar correctly
// honors bit-11 and round-trips the CJK name.
test("bsdtar round-trips a CJK entry name without mangling", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-zip-"));
  const zip = buildZip([{ name: "中文目录/文件名.txt", data: new TextEncoder().encode("hi") }]);
  const zipPath = join(dir, "a.zip");
  writeFileSync(zipPath, zip);
  const r = spawnSync("bsdtar", ["-xf", zipPath, "-C", dir], { encoding: "utf8" });
  expect(r.status).toBe(0);
  const out = join(dir, "中文目录", "文件名.txt");
  expect(existsSync(out)).toBe(true);
  expect(readFileSync(out, "utf8")).toBe("hi");
});
