import { test, expect } from "bun:test";
import { AGENT_VERSION } from "./version";
import pkg from "../package.json";

test("AGENT_VERSION matches package.json semver", () => {
  expect(AGENT_VERSION).toBe(pkg.version);
  expect(AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
