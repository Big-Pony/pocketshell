import { test, expect } from "bun:test";
import { ensureLocalIdentity, signBinary, hasSigningIdentity, SIGN_IDENTITY, SIGN_IDENTIFIER } from "./codesign-provision";

test("constants match existing scripts", () => {
  expect(SIGN_IDENTITY).toBe("PocketShell Self-Signed");
  expect(SIGN_IDENTIFIER).toBe("com.myt.pocketshell");
});

test("no-op on non-darwin", async () => {
  if (process.platform === "darwin") return; // real behavior tested manually on mac
  expect(await ensureLocalIdentity()).toBe(false);
  expect(await signBinary("/bin/echo")).toBe(false);
});

// Side-effect-free on darwin: this machine has no "PocketShell Self-Signed"
// identity provisioned, so signBinary must short-circuit to false via the
// read-only `security find-identity` check — no codesign invocation, no
// keychain mutation. Guards against ever running real provisioning here.
test("signBinary returns false without a provisioned identity (darwin, read-only)", async () => {
  if (process.platform !== "darwin") return;
  expect(await hasSigningIdentity()).toBe(false);
  expect(await signBinary("/tmp/somecopy")).toBe(false);
});
