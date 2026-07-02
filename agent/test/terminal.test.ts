import { test, expect } from "bun:test";
import { TerminalService } from "../src/terminal";

const hasTmux = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;
const NAME = "pocketshell_test";

test.skipIf(!hasTmux)("ensure creates a session and streams echoed output", async () => {
  const svc = new TerminalService();
  const chunks: string[] = [];
  svc.onOutput((_name, chunk) => chunks.push(new TextDecoder().decode(chunk)));

  svc.ensure(NAME, { cols: 80, rows: 24 });
  await Bun.sleep(400);                 // let attach settle
  svc.write(NAME, new TextEncoder().encode("echo TERM_OK\n"));
  await Bun.sleep(600);                 // let output flush

  const all = chunks.join("");
  expect(all).toContain("TERM_OK");

  await svc.kill(NAME);
  svc.dispose();
});

test.skipIf(!hasTmux)("list reports the live session", async () => {
  const svc = new TerminalService();
  svc.ensure(NAME, { cols: 80, rows: 24 });
  await Bun.sleep(300);
  expect(svc.list().some((s) => s.name === NAME)).toBe(true);
  await svc.kill(NAME);
  svc.dispose();
});

test.skipIf(!hasTmux)("state transitions run -> wait after output goes quiet", async () => {
  const svc = new TerminalService();
  svc.ensure(NAME, { cols: 80, rows: 24 });
  await Bun.sleep(300);
  svc.write(NAME, new TextEncoder().encode("echo BUSY\n"));
  await Bun.sleep(100);
  const busy = svc.list().find((s) => s.name === NAME);
  expect(busy?.state).toBe("run");        // just emitted output
  await Bun.sleep(700);                    // > RUN_WINDOW_MS, now quiet
  const idle = svc.list().find((s) => s.name === NAME);
  expect(idle?.state).toBe("wait");
  await svc.kill(NAME);
  svc.dispose();
});

test.skipIf(!hasTmux)("onSessionsChange fires when a session's state changes", async () => {
  const svc = new TerminalService();
  let fired = 0;
  svc.onSessionsChange(() => { fired++; });
  svc.ensure(NAME, { cols: 80, rows: 24 });
  await Bun.sleep(1600);                    // let the 1s scanner run at least once
  expect(fired).toBeGreaterThan(0);
  await svc.kill(NAME);
  svc.dispose();
});

test.skipIf(!hasTmux)("rename changes the session name in the list", async () => {
  const svc = new TerminalService();
  const NEW = "pocketshell_test_renamed";
  svc.ensure(NAME, { cols: 80, rows: 24 });
  await Bun.sleep(300);
  svc.rename(NAME, NEW);
  const names = svc.list().map((s) => s.name);
  expect(names).toContain(NEW);
  expect(names).not.toContain(NAME);
  await svc.kill(NEW);
  svc.dispose();
});
