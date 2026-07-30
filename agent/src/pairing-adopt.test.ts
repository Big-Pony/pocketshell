import { test, expect } from "bun:test";
import { shouldAdoptDiskPairing } from "./pairing";

test("adopts disk code when the in-memory code is dead", () => {
  expect(shouldAdoptDiskPairing({ memoryLive: false, memoryMintedAt: 1000, diskMintedAt: 500 })).toBe(true);
});

test("adopts a NEWER disk code even while the in-memory code is still live", () => {
  // This is the 2026-07-30 field bug: agent booted at t=1000 and minted a code
  // valid for 300s; the operator ran `pocketshell-agent pair` at t=2000. The
  // freshly minted disk code must win, or the operator gets a bogus bad_code.
  expect(shouldAdoptDiskPairing({ memoryLive: true, memoryMintedAt: 1000, diskMintedAt: 2000 })).toBe(true);
});

test("keeps the live in-memory code when the disk code is older or same-age", () => {
  expect(shouldAdoptDiskPairing({ memoryLive: true, memoryMintedAt: 2000, diskMintedAt: 1000 })).toBe(false);
  expect(shouldAdoptDiskPairing({ memoryLive: true, memoryMintedAt: 2000, diskMintedAt: 2000 })).toBe(false);
});

test("legacy disk record (mintedAt 0) never preempts a live in-memory code", () => {
  expect(shouldAdoptDiskPairing({ memoryLive: true, memoryMintedAt: 1000, diskMintedAt: 0 })).toBe(false);
  expect(shouldAdoptDiskPairing({ memoryLive: false, memoryMintedAt: 1000, diskMintedAt: 0 })).toBe(true);
});
