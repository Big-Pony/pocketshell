import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeviceRegistry } from "./device-registry";
import { readStamp, stampsEqual, removedKeys, watchRegistryFile } from "./registry-watch";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ps-regwatch-"));
}

test("removedKeys reports only the disappearing keys", () => {
  expect(removedKeys(["A", "B", "C"], ["A", "C"])).toEqual(["B"]);
  expect(removedKeys(["A"], ["A"])).toEqual([]);
  // Additions need no reaction — authorize() reads the live registry, and a
  // device the operator added from the CLI is one they vouched for.
  expect(removedKeys(["A"], ["A", "B"])).toEqual([]);
  expect(removedKeys(["A", "B"], [])).toEqual(["A", "B"]);
});

test("stampsEqual treats a missing file as its own state", () => {
  expect(stampsEqual(null, null)).toBe(true);
  expect(stampsEqual(null, { mtimeMs: 1, size: 2 })).toBe(false);
  expect(stampsEqual({ mtimeMs: 1, size: 2 }, null)).toBe(false);
  expect(stampsEqual({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 2 })).toBe(true);
  // Size is part of the stamp because two writes inside the same millisecond
  // share an mtime — without it, a fast rewrite would go unnoticed.
  expect(stampsEqual({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 3 })).toBe(false);
  expect(stampsEqual({ mtimeMs: 1, size: 2 }, { mtimeMs: 9, size: 2 })).toBe(false);
});

test("readStamp returns null for a missing file rather than throwing", () => {
  expect(readStamp(join(tmpDir(), "nope.json"))).toBeNull();
});

// Deterministic clock: the poll callback is captured and invoked by hand, so
// these assert the state machine rather than racing a real timer.
function manualWatch(over: Partial<Parameters<typeof watchRegistryFile>[0]> = {}) {
  let tick: (() => void) | null = null;
  let cleared = false;
  const calls: string[][] = [];
  const handle = watchRegistryFile({
    stamp: () => ({ mtimeMs: 0, size: 0 }),
    current: () => [],
    reload: () => [],
    onRemoved: (p) => calls.push(p),
    ...over,
    setInterval: ((fn: () => void) => { tick = fn; return 1 as any; }) as any,
    clearInterval: (() => { cleared = true; }) as any,
  });
  return { tick: () => tick!(), stop: () => handle.stop(), calls, wasCleared: () => cleared };
}

test("watch does nothing while the stamp is unchanged", () => {
  let reloads = 0;
  const w = manualWatch({
    stamp: () => ({ mtimeMs: 100, size: 5 }),
    reload: () => { reloads++; return []; },
  });
  w.tick();
  w.tick();
  expect(reloads).toBe(0); // no reload = no wasted disk reads on an idle box
  expect(w.calls).toEqual([]);
});

test("watch reloads and reports removals when the stamp changes", () => {
  let stamp = { mtimeMs: 1, size: 10 };
  let onDisk = ["A", "B"];
  const w = manualWatch({
    stamp: () => stamp,
    current: () => ["A", "B"],
    reload: () => onDisk,
  });
  stamp = { mtimeMs: 2, size: 8 };
  onDisk = ["A"];
  w.tick();
  expect(w.calls).toEqual([["B"]]);
});

test("watch does not re-fire for an unchanged stamp after a change", () => {
  let stamp = { mtimeMs: 1, size: 10 };
  const w = manualWatch({
    stamp: () => stamp,
    current: () => ["A"],
    reload: () => [],
  });
  stamp = { mtimeMs: 2, size: 0 };
  w.tick();
  w.tick(); // same stamp now — must not report the removal twice
  expect(w.calls).toEqual([["A"]]);
});

test("watch stays silent when the file changes but no device was removed", () => {
  // touch() rewrites devices.json on every heartbeat. That must not be
  // mistaken for a revocation.
  let stamp = { mtimeMs: 1, size: 10 };
  const w = manualWatch({
    stamp: () => stamp,
    current: () => ["A"],
    reload: () => ["A"],
  });
  stamp = { mtimeMs: 2, size: 12 };
  w.tick();
  expect(w.calls).toEqual([]);
});

test("stop clears the interval", () => {
  const w = manualWatch();
  w.stop();
  expect(w.wasCleared()).toBe(true);
});

// ——— The bug this module exists for ———
//
// Verified against the real registry, not doubles: before reload() existed,
// step 3 returned true (the "removed" device still authorized) and step 4 wrote
// it back to disk. Both are asserted below.
test("CLI removal in another process takes effect in the resident registry", () => {
  const dir = tmpDir();
  const file = join(dir, "devices.json");

  const resident = loadDeviceRegistry(file);   // the long-running agent
  resident.add("PUBX", "phone");
  resident.touch("PUBX", "127.0.0.1");
  expect(resident.has("PUBX")).toBe(true);

  const cli = loadDeviceRegistry(file);        // `devices remove` — separate process
  expect(cli.remove("PUBX")).toBe(true);

  const before = resident.list().map((d) => d.pubKey);
  const after = resident.reload().map((d) => d.pubKey);
  expect(removedKeys(before, after)).toEqual(["PUBX"]);

  // The device must actually lose authorization...
  expect(resident.has("PUBX")).toBe(false);
  // ...and a later heartbeat must not resurrect it. touch() on a device that is
  // gone from the in-memory list is a no-op; before reload() it persisted the
  // stale record and silently undid the CLI's removal.
  resident.touch("PUBX", "127.0.0.1");
  expect(JSON.parse(readFileSync(file, "utf8")).devices).toEqual([]);

  rmSync(dir, { recursive: true, force: true });
});

test("reload keeps the current roster when the file is mid-write / corrupt", () => {
  // A poll can land between the CLI's write and rename. Parsing garbage must
  // not read as "every device was removed" — that would revoke the whole fleet.
  const dir = tmpDir();
  const file = join(dir, "devices.json");
  const reg = loadDeviceRegistry(file);
  reg.add("PUBA", "a");
  writeFileSync(file, "{ this is not json");
  expect(reg.reload().map((d) => d.pubKey)).toEqual(["PUBA"]);
  expect(reg.has("PUBA")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
