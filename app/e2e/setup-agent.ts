// Start a real PocketShell agent for Playwright e2e tests.
// Pre-authorizes a generated browser identity so the test can skip the pairing UI.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DH from "noise-handshake/dh";
import { toB64 } from "../src/lib/bytes";

// Import agent modules via absolute paths so this script can be run from app/.
const agentRoot = join(import.meta.dir, "../../agent/src");
const { loadConfig } = await import(join(agentRoot, "config.ts"));
const { startServer } = await import(join(agentRoot, "server.ts"));

const keyDir = mkdtempSync(join(tmpdir(), "ps-playwright-"));

// Browser identity that the test will inject into localStorage.
const browserKp = DH.generateKeyPair();
const browserPub = new Uint8Array(browserKp.publicKey);
const browserSec = new Uint8Array(browserKp.secretKey);

const cfg = loadConfig({
  POCKETSHELL_KEY_DIR: keyDir,
  POCKETSHELL_AUTHORIZED_KEYS: toB64(browserPub),
  POCKETSHELL_PORT: "0",
  POCKETSHELL_HOST: "127.0.0.1",
});

const srv = startServer({ port: 0, config: cfg });

const info = {
  keyDir,
  port: srv.port,
  agentPubKey: toB64(cfg.identity.publicKey),
  browserIdentity: {
    publicKey: toB64(browserPub),
    secretKey: toB64(browserSec),
  },
};

// Print config on stdout so Playwright can read it.
console.log(JSON.stringify(info));

// Keep alive until stdin closes or SIGTERM.
process.stdin.resume();
process.on("SIGTERM", () => { srv.stop(); process.exit(0); });
process.on("SIGINT", () => { srv.stop(); process.exit(0); });
