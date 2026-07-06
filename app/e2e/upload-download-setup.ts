// E2E setup for upload/download: start a real agent, pre-authorize a browser
// identity, seed a test directory, and print connection info as JSON.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DH from "noise-handshake/dh";
import { toB64 } from "../src/lib/bytes";

const agentRoot = join(import.meta.dir, "../../agent/src");
const { loadConfig } = await import(join(agentRoot, "config.ts"));
const { startServer } = await import(join(agentRoot, "server.ts"));

const keyDir = mkdtempSync(join(tmpdir(), "ps-upload-download-"));
const testDir = mkdtempSync(join(tmpdir(), "ps-upload-download-fs-"));
mkdirSync(join(testDir, "sub"));
writeFileSync(join(testDir, "hello.txt"), "hello world\n");
writeFileSync(join(testDir, "sub", "nested.txt"), "nested content\n");

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

console.log(JSON.stringify({
  keyDir,
  testDir,
  port: srv.port,
  agentPubKey: toB64(cfg.identity.publicKey),
  browserIdentity: {
    publicKey: toB64(browserPub),
    secretKey: toB64(browserSec),
  },
}));

process.stdin.resume();
process.on("SIGTERM", () => { srv.stop(); process.exit(0); });
process.on("SIGINT", () => { srv.stop(); process.exit(0); });
