import { test, expect } from "bun:test";
import { compareSemver, hasUpdate, assetNameForPlatform, parseSha256Sums } from "./update-core";

test("compareSemver orders versions", () => {
  expect(compareSemver("0.3.0", "0.3.1")).toBe(-1);
  expect(compareSemver("0.4.0", "0.3.9")).toBe(1);
  expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  expect(compareSemver("v0.3.0", "0.3.0")).toBe(0); // tolerate leading v
});

test("hasUpdate only when latest is strictly greater", () => {
  expect(hasUpdate("0.3.0", "0.3.1")).toBe(true);
  expect(hasUpdate("0.3.0", "0.3.0")).toBe(false);
  expect(hasUpdate("0.4.0", "0.3.0")).toBe(false);
});

test("assetNameForPlatform maps the 4 supported targets", () => {
  expect(assetNameForPlatform("linux", "x64")).toBe("pocketshell-agent-linux-x64");
  expect(assetNameForPlatform("linux", "arm64")).toBe("pocketshell-agent-linux-arm64");
  expect(assetNameForPlatform("darwin", "arm64")).toBe("pocketshell-agent-darwin-arm64");
  expect(assetNameForPlatform("darwin", "x64")).toBe("pocketshell-agent-darwin-x64");
  expect(assetNameForPlatform("win32", "x64")).toBeNull();
  expect(assetNameForPlatform("linux", "ia32")).toBeNull();
});

test("parseSha256Sums reads shasum output with or without ./ prefix", () => {
  const linuxHash = "a".repeat(64);
  const darwinHash = "b".repeat(64);
  const txt = [
    `${linuxHash}  ./pocketshell-agent-linux-x64.tar.gz`,
    `${darwinHash}  pocketshell-agent-darwin-arm64.tar.gz`,
  ].join("\n");
  const m = parseSha256Sums(txt);
  expect(m.get("pocketshell-agent-linux-x64.tar.gz")).toBe(linuxHash);
  expect(m.get("pocketshell-agent-darwin-arm64.tar.gz")).toBe(darwinHash);
  // Verify that truncated (8-char) hashes are rejected
  const badTxt = "12345678  pocketshell-agent-linux-x64.tar.gz";
  const badM = parseSha256Sums(badTxt);
  expect(badM.get("pocketshell-agent-linux-x64.tar.gz")).toBeUndefined();
});
