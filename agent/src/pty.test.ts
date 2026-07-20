import { test, expect } from "bun:test";
import { ResizeGate, spawnPty } from "./pty";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- ResizeGate: pure decision logic (no Bun.Terminal involved) ---

test("ResizeGate applies the first resize even when repeated later", () => {
  const g = new ResizeGate();
  expect(g.shouldResize(80, 24)).toBe(true); // first call always applies
});

test("ResizeGate skips consecutive duplicates of the same size", () => {
  const g = new ResizeGate();
  expect(g.shouldResize(80, 24)).toBe(true);
  expect(g.shouldResize(80, 24)).toBe(false);
  expect(g.shouldResize(80, 24)).toBe(false);
});

test("ResizeGate applies when only cols or only rows change", () => {
  const g = new ResizeGate();
  g.shouldResize(80, 24);
  expect(g.shouldResize(100, 24)).toBe(true); // cols changed
  expect(g.shouldResize(100, 30)).toBe(true); // rows changed
  expect(g.shouldResize(100, 30)).toBe(false); // unchanged again
});

test("ResizeGate re-applies a previously seen size after an intermediate change", () => {
  const g = new ResizeGate();
  g.shouldResize(80, 24);
  g.shouldResize(100, 40);
  expect(g.shouldResize(80, 24)).toBe(true); // gate only remembers the LAST size
  expect(g.shouldResize(100, 40)).toBe(true);
});

// --- spawnPty integration: the gate actually suppresses SIGWINCH ---
// Coverage boundary: Bun.Terminal.resize winsize itself is not asserted here
// (no mockable seam); what is asserted is the observable child-side effect —
// SIGWINCH delivery count — which is the whole point of the gate.

test("spawnPty delivers SIGWINCH only on real size changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pty-resize-gate-"));
  const file = join(dir, "winch-count");
  // The child counts delivered SIGWINCHes by appending one line per trap.
  // sh runs the trap between its 100ms sleeps (verified on macOS sh), and
  // resizes are spaced by 300ms so signals never coalesce into one delivery.
  const pty = spawnPty({
    cmd: ["sh", "-c", `trap 'echo w >> ${file}' WINCH; while :; do sleep 0.1; done`],
    cols: 80,
    rows: 24,
  });
  const countWinches = () =>
    existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  try {
    await Bun.sleep(400); // let sh install the trap before any signal
    pty.resize(90, 30); // first resize: always applies            → SIGWINCH #1
    await Bun.sleep(300);
    pty.resize(90, 30); // unchanged: gate skips (no ioctl, no signal)
    pty.resize(90, 30); // unchanged: gate skips
    await Bun.sleep(300);
    pty.resize(100, 40); // cols+rows changed                       → SIGWINCH #2
    await Bun.sleep(300);
    pty.resize(100, 40); // unchanged: gate skips
    pty.resize(100, 50); // rows-only change                        → SIGWINCH #3
    await Bun.sleep(500); // flush pending traps
    expect(countWinches()).toBe(3);
  } finally {
    pty.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);

// --- spawnPty env merge: opts.env reaches the spawned process ---

test("spawnPty merges opts.env", async () => {
  const chunks: string[] = [];
  const h = spawnPty({ cmd: ["sh", "-c", "echo $POCKETSHELL_NOTIFY_SESSION"], cols: 80, rows: 24, env: { POCKETSHELL_NOTIFY_SESSION: "work" } });
  h.onData((c) => chunks.push(new TextDecoder().decode(c)));
  await new Promise<void>((r) => h.onExit(() => r()));
  expect(chunks.join("")).toContain("work");
});
