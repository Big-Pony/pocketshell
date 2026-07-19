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

// Deterministic + isolated: inject the `security find-identity` output and a
// codesign stub so assertions never depend on THIS machine's real keychain
// (which may or may not have the identity provisioned) and never invoke real
// codesign or mutate the keychain.
test("signBinary short-circuits to false when the identity is absent (no codesign call)", async () => {
  const absent = { platform: "darwin", findIdentity: async () => "     0 valid identities found\n" };
  expect(await hasSigningIdentity(SIGN_IDENTITY, absent)).toBe(false);
  let codesignCalled = false;
  const ok = await signBinary("/tmp/somecopy", { ...absent, codesign: async () => { codesignCalled = true; return 0; } });
  expect(ok).toBe(false);
  expect(codesignCalled).toBe(false); // must not invoke codesign without an identity
});

test("signBinary re-signs the given path when the identity is present", async () => {
  const present = { platform: "darwin", findIdentity: async () => `  1) ABCDEF0123 "${SIGN_IDENTITY}"\n     1 valid identities found\n` };
  let signed = "";
  const ok = await signBinary("/tmp/newbin", { ...present, codesign: async (p) => { signed = p; return 0; } });
  expect(ok).toBe(true);
  expect(signed).toBe("/tmp/newbin");
});

test("signBinary reports a codesign failure as false", async () => {
  const present = { platform: "darwin", findIdentity: async () => `"${SIGN_IDENTITY}"` };
  const ok = await signBinary("/tmp/newbin", { ...present, codesign: async () => 1 });
  expect(ok).toBe(false);
});
