import { test, expect } from "bun:test";
import { ShellService } from "./shell-service";
import type { PtyHandle } from "./pty";

// Fake PTY: records writes/resizes, lets the test push data & trigger exit.
function fakePty() {
  let dataCb: ((c: Uint8Array) => void) | null = null;
  let exitCb: ((code: number) => void) | null = null;
  const writes: Uint8Array[] = [];
  let killed = false;
  const handle: PtyHandle = {
    write: (d) => writes.push(d),
    resize: () => {},
    kill: () => { killed = true; },
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
  };
  return {
    handle, writes,
    emit: (c: Uint8Array) => dataCb?.(c),
    exit: (code: number) => exitCb?.(code),
    get killed() { return killed; },
  };
}

test("create registers a live shell session listed as kind shell / state run", () => {
  const p = fakePty();
  const svc = new ShellService({ spawn: () => p.handle, shellCmd: ["/bin/zsh"] });
  let changed = 0; svc.onChange(() => changed++);
  svc.create("sh1", { cols: 80, rows: 24 });
  expect(svc.has("sh1")).toBe(true);
  const list = svc.list();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name: "sh1", kind: "shell", state: "run", attached: true });
  expect(changed).toBe(1);
});

test("output is fanned out and retained in replay for since()", () => {
  const p = fakePty();
  const svc = new ShellService({ spawn: () => p.handle });
  const out: Uint8Array[] = [];
  svc.onOutput((name, chunk) => { if (name === "sh1") out.push(chunk); });
  svc.create("sh1", {});
  p.emit(new Uint8Array([104, 105])); // "hi"
  expect(out).toHaveLength(1);
  const { frames } = svc.since("sh1", 0);
  expect(frames.map((f) => [...f.data])).toEqual([[104, 105]]);
});

test("write forwards to the pty, resize is accepted, kill destroys", () => {
  const p = fakePty();
  const svc = new ShellService({ spawn: () => p.handle });
  svc.create("sh1", {});
  svc.write("sh1", new Uint8Array([97]));
  expect(p.writes).toHaveLength(1);
  svc.resize("sh1", 100, 40);
  expect(svc.list()[0]).toMatchObject({ cols: 100, rows: 40 });
  svc.kill("sh1");
  expect(p.killed).toBe(true);
  expect(svc.has("sh1")).toBe(false);
});

test("pty exit removes the session and fires onExit + onChange", () => {
  const p = fakePty();
  const svc = new ShellService({ spawn: () => p.handle });
  let exited: [string, number] | null = null;
  svc.onExit((name, code) => { exited = [name, code]; });
  svc.create("sh1", {});
  p.exit(0);
  expect(exited).toEqual(["sh1", 0]);
  expect(svc.has("sh1")).toBe(false);
});
