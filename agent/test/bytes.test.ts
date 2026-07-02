import { test, expect } from "bun:test";
import { toB64, fromB64 } from "../src/bytes";

test("round-trips arbitrary bytes including non-UTF8", () => {
  const src = new Uint8Array([0, 1, 2, 27, 91, 255, 254, 0x41]);
  const round = fromB64(toB64(src));
  expect(Array.from(round)).toEqual(Array.from(src));
});

test("empty array round-trips", () => {
  expect(Array.from(fromB64(toB64(new Uint8Array())))).toEqual([]);
});
