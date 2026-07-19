import { test, expect } from "bun:test";
import { isSupervised, restartSelf } from "./self-restart";

test("systemd INVOCATION_ID marks supervised", () => {
  expect(isSupervised({ INVOCATION_ID: "abc" })).toBe(true);
  expect(isSupervised({}, () => "otherd")).toBe(false);
});

test("supervised restart just exits(0), no spawn", () => {
  let exited = -1, spawned = 0;
  restartSelf({ supervised: true, exit: ((c: number) => { exited = c; }) as any, spawn: () => { spawned++; } });
  expect(exited).toBe(0);
  expect(spawned).toBe(0);
});

test("unsupervised restart spawns detached then exits", () => {
  let exited = -1; const calls: any[] = [];
  restartSelf({
    supervised: false, execPath: "/x/bin", argv: ["--flag"],
    spawn: (cmd, opts) => calls.push({ cmd, opts }), exit: ((c: number) => { exited = c; }) as any,
  });
  expect(calls[0].cmd).toEqual(["/x/bin", "--flag"]);
  expect(calls[0].opts).toMatchObject({ detached: true });
  expect(exited).toBe(0);
});
