import { test, expect } from "vitest";
import { resolveKey, EMPTY_MODS, activeMods } from "../src/lib/input-router";

test("Del resolves to the forward-delete escape sequence", () => {
  const r = resolveKey("Del", activeMods(EMPTY_MODS));
  expect(r).toEqual({ kind: "bytes", text: "\x1b[3~" });
});
