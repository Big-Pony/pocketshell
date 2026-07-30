import { test, expect } from "bun:test";
import { extractPairingString, backupPath } from "./install-runner";

test("extractPairingString picks the pairing token out of journal output", () => {
  const log = [
    "Jul 30 12:17:37 host pocketshell-agent[1]: [pocketshell] listening on 127.0.0.1:8722 (TLS off)",
    "Jul 30 12:17:37 host pocketshell-agent[1]: [pocketshell] pairing string (paste into the app to connect):",
    "Jul 30 12:17:37 host pocketshell-agent[1]:   pocketshell-pair:eyJ2IjoxLCJwdWIiOiJhYmMifQ",
    "Jul 30 12:17:37 host pocketshell-agent[1]: [pocketshell] pairing code valid for ~300s",
  ].join("\n");
  expect(extractPairingString(log)).toBe("pocketshell-pair:eyJ2IjoxLCJwdWIiOiJhYmMifQ");
});

test("extractPairingString returns the LAST token when the log has several", () => {
  // A restarted service leaves older codes above; only the newest one is live.
  const log = "pocketshell-pair:OLDoldOLD\nnoise\npocketshell-pair:NEWnewNEW";
  expect(extractPairingString(log)).toBe("pocketshell-pair:NEWnewNEW");
});

test("extractPairingString returns null when absent", () => {
  expect(extractPairingString("[pocketshell] listening on 127.0.0.1:8722")).toBeNull();
  expect(extractPairingString("")).toBeNull();
});

test("backupPath appends .bak.<stamp>", () => {
  expect(backupPath("/etc/systemd/system/pocketshell.service", "20260730-121551"))
    .toBe("/etc/systemd/system/pocketshell.service.bak.20260730-121551");
});
