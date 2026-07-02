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

test.skipIf(!hasTmux)("output is delivered under the new name after rename", async () => {
  const svc = new TerminalService();
  const NEW = "pocketshell_test_renamed_out";
  const got: string[] = [];
  svc.onOutput((name, chunk) => { if (name === NEW) got.push(new TextDecoder().decode(chunk)); });
  svc.ensure(NAME, { cols: 80, rows: 24 });
  await Bun.sleep(400);
  svc.rename(NAME, NEW);
  await Bun.sleep(400);                 // let the re-attach settle
  svc.write(NEW, new TextEncoder().encode("echo RENAMED_OUT\n"));
  await Bun.sleep(700);
  expect(got.join("")).toContain("RENAMED_OUT");  // must arrive tagged with NEW name
  await svc.kill(NEW);
  svc.dispose();
});

test.skipIf(!hasTmux)("external detach does not end the session (auto re-attach)", async () => {
  const svc = new TerminalService();
  const exited: string[] = [];
  svc.onExit((name) => exited.push(name));
  svc.ensure(NAME, { cols: 80, rows: 24 });
  await Bun.sleep(400);
  // Detach every client attached to the session; the tmux session must survive.
  Bun.spawnSync(["tmux", "detach-client", "-s", NAME]);
  await Bun.sleep(600);
  expect(exited).not.toContain(NAME);          // no exit fired
  expect(svc.list().some((s) => s.name === NAME)).toBe(true); // still listed
  // And it still streams after re-attach:
  const chunks: string[] = [];
  svc.onOutput((_n, c) => chunks.push(new TextDecoder().decode(c)));
  svc.write(NAME, new TextEncoder().encode("echo REATTACH_OK\n"));
  await Bun.sleep(600);
  expect(chunks.join("")).toContain("REATTACH_OK");
  await svc.kill(NAME);
  svc.dispose();
});
