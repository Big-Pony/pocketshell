import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPairingString, backupPath, launchdDomain } from "./install-runner";

test("extractPairingString picks the pairing token out of journal output", () => {
  const log = [
    "Jul 30 12:17:37 host pocketshell-agent[1]: [pocketshell] listening on 127.0.0.1:8722 (TLS off)",
    "Jul 30 12:17:37 host pocketshell-agent[1]: [pocketshell] pairing string (paste into the app to connect):",
    "Jul 30 12:17:37 host pocketshell-agent[1]:   pocketshell-pair:eyJ2IjoxLCJwdWIiOiJhYmMifQ",
    "Jul 30 12:17:37 host pocketshell-agent[1]: [pocketshell] pairing code valid for ~300s",
  ].join("\n");
  expect(extractPairingString(log)).toBe("pocketshell-pair:eyJ2IjoxLCJwdWIiOiJhYmMifQ");
});

test("extractPairingString returns the LAST token when the log has several", () => {
  // A restarted service leaves older codes above; only the newest one is live.
  const log = "pocketshell-pair:OLDoldOLD\nnoise\npocketshell-pair:NEWnewNEW";
  expect(extractPairingString(log)).toBe("pocketshell-pair:NEWnewNEW");
});

test("extractPairingString returns null when absent", () => {
  expect(extractPairingString("[pocketshell] listening on 127.0.0.1:8722")).toBeNull();
  expect(extractPairingString("")).toBeNull();
});

test("backupPath appends .bak.<stamp>", () => {
  expect(backupPath("/etc/systemd/system/pocketshell.service", "20260730-121551"))
    .toBe("/etc/systemd/system/pocketshell.service.bak.20260730-121551");
});

test("launchdDomain targets the invoking user's GUI domain", () => {
  expect(launchdDomain(501)).toBe("gui/501");
  expect(launchdDomain(1000)).toBe("gui/1000");
});

// Regression for a bug found during the 2026-07-30 dev-server acceptance run:
// uninstall printed "密钥目录 /root/.pocketshell" because printKeepNotice
// derived the path from the *calling* process's HOME — which under sudo is
// root's, not the service user's. The real keyDir was /home/myt/.pocketshell.
// Pointing the operator at a path that does not exist defeats the entire point
// of the notice, so the value is now read back out of the unit file that is
// about to be deleted.
import { keyDirFromUnit } from "./install-runner";

test("keyDirFromUnit reads POCKETSHELL_KEY_DIR out of a systemd unit", () => {
  const unit = [
    "[Service]",
    "User=myt",
    "ExecStart=/usr/local/bin/pocketshell-agent",
    "Environment=POCKETSHELL_HOST=127.0.0.1",
    "Environment=POCKETSHELL_KEY_DIR=/home/myt/.pocketshell",
    "Restart=always",
  ].join("\n");
  expect(keyDirFromUnit(unit)).toBe("/home/myt/.pocketshell");
});

test("keyDirFromUnit reads POCKETSHELL_KEY_DIR out of a launchd plist", () => {
  const plist = [
    "  <dict>",
    "    <key>POCKETSHELL_HOST</key><string>127.0.0.1</string>",
    "    <key>POCKETSHELL_KEY_DIR</key><string>/Users/myt/.pocketshell</string>",
    "  </dict>",
  ].join("\n");
  expect(keyDirFromUnit(plist)).toBe("/Users/myt/.pocketshell");
});

test("keyDirFromUnit returns null when the key is absent", () => {
  // A hand-written unit may omit it; the caller then falls back to a generic
  // hint rather than printing a fabricated path.
  expect(keyDirFromUnit("[Service]\nUser=myt\nRestart=always")).toBeNull();
  expect(keyDirFromUnit("")).toBeNull();
});

// Found during the 2026-07-30 dev-server acceptance run: on a machine that
// already has paired devices, config.ts sets pairingMode=false, so the agent
// never mints a boot code and the log holds no pairing string at all. install
// then printed "没能自动取到配对串，请看 journalctl" — honest, but the hint is
// useless because the log was never going to contain one. Reinstalling is a
// common path, so the two cases must read differently.
import { pairedDeviceCount } from "./install-runner";

test("pairedDeviceCount reads devices.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-inst-"));
  try {
    expect(pairedDeviceCount(dir)).toBe(0); // no file yet -> fresh install
    writeFileSync(join(dir, "devices.json"), JSON.stringify({
      v: 1,
      devices: [
        { pubKey: "AAA", name: "phone", addedAt: "2026-07-30T00:00:00Z" },
        { pubKey: "BBB", name: "tablet", addedAt: "2026-07-30T00:00:00Z" },
      ],
    }));
    expect(pairedDeviceCount(dir)).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pairedDeviceCount treats a corrupt or empty registry as zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-inst-"));
  try {
    writeFileSync(join(dir, "devices.json"), "{ not json");
    expect(pairedDeviceCount(dir)).toBe(0);
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ v: 1, devices: [] }));
    expect(pairedDeviceCount(dir)).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Found on the 2026-07-30 dev-server acceptance run, reinstall path: copying
// onto /usr/local/bin/pocketshell-agent while the service was executing it
// threw ETXTBSY ("text file is busy") and the command died with a raw Bun
// stack trace. Linux refuses to write a file that is currently being executed.
// Unlinking first is the standard fix: it only detaches the directory entry,
// the running process keeps its inode alive, and the copy lands on a brand-new
// inode. install.sh already did this; the TypeScript path did not.
import { replaceBinary } from "./install-runner";

// The property under test is that the OLD inode survives the replacement,
// untouched, so a process still executing it keeps its bytes.
//
// It is tempting to assert that on the inode NUMBER (`stat(dst).ino` changed),
// and that is what this test originally did — but an inode number is a reusable
// slot, not an identity. `rm` frees it and the very next `copyFileSync` may be
// handed the same number straight back; whether it is depends entirely on the
// filesystem's allocator. macOS/APFS hands out monotonically increasing numbers
// so the assertion held on every developer machine, while ext4 on ubuntu-latest
// prefers to reuse the just-freed inode and returned the identical number —
// which is exactly what turned CI red ("Expected: not 9177411"). The old
// assertion was therefore not merely flaky, it was testing the allocator.
//
// A hard link pins the old inode, so its content is readable afterwards and the
// two implementations are told apart with no allocator dependence:
//   unlink-then-copy -> the link still reads "OLD" (new inode for dst)
//   copy-in-place    -> the link reads "NEW" (same inode, overwritten)
test("replaceBinary unlinks an existing target before copying", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-bin-"));
  try {
    const src = join(dir, "src-bin");
    const dst = join(dir, "dst-bin");
    writeFileSync(src, "NEW", { mode: 0o755 });
    writeFileSync(dst, "OLD", { mode: 0o755 });
    // Stands in for the running process holding the old binary open.
    const pinned = join(dir, "pinned-bin");
    linkSync(dst, pinned);

    replaceBinary(src, dst);

    expect(readFileSync(dst, "utf8")).toBe("NEW");
    // The whole point: the old inode was detached, not overwritten.
    expect(readFileSync(pinned, "utf8")).toBe("OLD");
    expect(statSync(dst).mode & 0o777).toBe(0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaceBinary works when the target does not exist yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-bin-"));
  try {
    const src = join(dir, "src-bin");
    const dst = join(dir, "sub", "dst-bin");
    writeFileSync(src, "NEW", { mode: 0o755 });
    replaceBinary(src, dst);
    expect(readFileSync(dst, "utf8")).toBe("NEW");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// v1.6.0 regression: install put the binary in root-owned /usr/local/bin while
// the service ran as a normal user, so in-app OTA failed with
// "EACCES: permission denied, copyfile … -> /usr/local/bin/.pocketshell.new".
// OTA needs write access to the binary's *directory* (it writes a temp file
// there and renames over the target), so the binary now lives in its own
// directory owned by the service user, with a symlink keeping the command on
// the global PATH.
import { symlinkTargetOk } from "./install-runner";

test("symlinkTargetOk detects a symlink already pointing at the right target", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-link-"));
  try {
    const target = join(dir, "real-bin");
    const link = join(dir, "link-bin");
    writeFileSync(target, "BIN", { mode: 0o755 });
    expect(symlinkTargetOk(link, target)).toBe(false);      // absent
    symlinkSync(target, link);
    expect(symlinkTargetOk(link, target)).toBe(true);       // correct
    expect(symlinkTargetOk(link, join(dir, "other"))).toBe(false); // stale
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("symlinkTargetOk returns false for a regular file at the link path", () => {
  // An older install left a real binary at /usr/local/bin; it must be replaced
  // by the symlink rather than silently kept (it would shadow the new one on
  // PATH and never receive OTA updates).
  const dir = mkdtempSync(join(tmpdir(), "ps-link-"));
  try {
    const link = join(dir, "link-bin");
    writeFileSync(link, "OLD BINARY", { mode: 0o755 });
    expect(symlinkTargetOk(link, join(dir, "real-bin"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// uninstall must know where the binary actually is, for the same reason it must
// know the keyDir: guessing a path is worse than reading the one the unit
// records. It also gates symlink removal — we only delete /usr/local/bin/… when
// it still points at our binary.
import { execStartFromUnit } from "./install-runner";

test("execStartFromUnit reads the binary path out of a systemd unit", () => {
  const unit = "[Service]\nUser=myt\nExecStart=/opt/pocketshell/pocketshell-agent\nRestart=always";
  expect(execStartFromUnit(unit)).toBe("/opt/pocketshell/pocketshell-agent");
});

test("execStartFromUnit falls back to null when absent", () => {
  expect(execStartFromUnit("[Service]\nUser=myt")).toBeNull();
});
