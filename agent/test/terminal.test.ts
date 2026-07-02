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
});

test.skipIf(!hasTmux)("list reports the live session", async () => {
  const svc = new TerminalService();
  svc.ensure(NAME, { cols: 80, rows: 24 });
  await Bun.sleep(300);
  expect(svc.list().some((s) => s.name === NAME)).toBe(true);
  await svc.kill(NAME);
});
