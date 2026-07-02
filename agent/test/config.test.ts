import { test, expect } from "bun:test";
import { loadConfig } from "../src/config";

test("provides defaults with no env", () => {
  const c = loadConfig({});
  expect(c.listen.host).toBe("127.0.0.1");
  expect(c.listen.port).toBe(8722);
  expect(c.replayBufferBytes).toBe(256 * 1024);
});

test("env overrides port and workspace root", () => {
  const c = loadConfig({ POCKETSHELL_PORT: "9001", POCKETSHELL_WORKSPACE: "/srv/proj" });
  expect(c.listen.port).toBe(9001);
  expect(c.workspaceRoot).toBe("/srv/proj");
});
