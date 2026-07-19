// macOS-only: provision (foreground, interactive) and re-sign (background,
// non-interactive) with a stable self-signed code-signing identity so the
// OTA-replaced binary's codesign designated requirement stays constant and
// TCC grants (Full Disk Access etc.) survive rebuilds. Same identity/
// identifier as agent/scripts/build-bin.ts and update-local.sh.
//
// Spike conclusion (docs/superpowers/specs/errata/2026-07-19-OTA-codesign-spike结论.md):
// a pure background (launchd) context cannot fully auto-provision a cert —
// trusting it (`add-trusted-cert`) needs admin/GUI auth, and authorizing the
// private key (`set-key-partition-list`) needs the login-keychain password.
// So `ensureLocalIdentity` must only ever be invoked from a foreground
// context (`--warmup`), never the background agent startup path. `signBinary`
// is safe in the background: it only re-signs with an identity that is
// already provisioned and trusted, and returns false (graceful degrade, OTA
// not blocked) if that identity isn't there.
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SIGN_IDENTITY = "PocketShell Self-Signed";
export const SIGN_IDENTIFIER = "com.myt.pocketshell";

export async function hasSigningIdentity(name = SIGN_IDENTITY): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const out = await $`security find-identity -v -p codesigning`.nothrow().text();
  return out.includes(name);
}

// Best-effort: create a stable self-signed code-signing identity in the login
// keychain so OTA re-signs keep a constant designated requirement (TCC grants
// persist). Returns false on any failure — callers must degrade gracefully
// to the manual Keychain Access provisioning guide. Only reachable from
// `--warmup` (foreground, operator present for the trust/auth prompts).
export async function ensureLocalIdentity(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (await hasSigningIdentity()) return true;
  const work = mkdtempSync(join(tmpdir(), "ps-id-"));
  const key = join(work, "k.pem"), crt = join(work, "c.pem"), p12 = join(work, "id.p12");
  const kc = `${process.env.HOME}/Library/Keychains/login.keychain-db`;
  const pw = "pocketshell";
  // p12 export must use legacy PBE: OpenSSL 3.6's default MAC algorithm is
  // rejected by `security import` ("MAC verification failed") — see spike.
  const r = await $`
    openssl req -x509 -newkey rsa:2048 -nodes -keyout ${key} -out ${crt} -days 3650 \
      -subj "/CN=${SIGN_IDENTITY}" -addext "extendedKeyUsage=codeSigning" &&
    openssl pkcs12 -export -inkey ${key} -in ${crt} -out ${p12} -passout pass:${pw} -name ${SIGN_IDENTITY} \
      -macalg sha1 -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES &&
    security import ${p12} -k ${kc} -P ${pw} -T /usr/bin/codesign
  `.nothrow().quiet();
  if (r.exitCode !== 0) return false;
  // Trust for code signing (GUI/admin auth prompt) + authorize the private key
  // for codesign without future prompts (needs the login-keychain password).
  // Both are interactive — only reachable from `--warmup`, never background.
  await $`security add-trusted-cert -d -r trustRoot -p codeSign ${crt}`.nothrow().quiet();
  // set-key-partition-list needs the login password; prompt the operator to run
  // it if we cannot (spike showed empty -k fails on password-protected keychains).
  return await hasSigningIdentity();
}

// Background-safe re-sign: uses an already-provisioned, already-trusted
// identity only. Returns false (skip signing, degrade — OTA is not blocked)
// if the identity isn't present; never attempts to provision one itself.
export async function signBinary(path: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (!(await hasSigningIdentity())) return false;
  const r = await $`codesign --force --sign ${SIGN_IDENTITY} --identifier ${SIGN_IDENTIFIER} ${path}`.nothrow().quiet();
  return r.exitCode === 0;
}
