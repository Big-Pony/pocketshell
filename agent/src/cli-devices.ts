// req 7-1: pure helpers for the `pocketshell-agent devices|pair` CLI subcommands
// (Linux headless ops without the /admin web page). server.ts wires these to
// loadConfig()/registry/pairing.
import { createHash } from "node:crypto";
import type { DeviceRecord } from "./device-registry";

export function fingerprint(pubKey: string): string {
  return createHash("sha256").update(pubKey).digest("hex").slice(0, 16);
}

export function formatDeviceList(records: DeviceRecord[]): string {
  if (records.length === 0) return "No paired devices.";
  const rows = records.map((d) => {
    const seen = d.lastSeen ?? "never";
    const ip = d.lastIp ?? "-";
    return `${fingerprint(d.pubKey)}  ${d.name}\n    added ${d.addedAt}  last-seen ${seen}  ip ${ip}`;
  });
  return `${records.length} device(s):\n${rows.join("\n")}`;
}

export type DeviceMatch =
  | { kind: "one"; record: DeviceRecord }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: DeviceRecord[] };

export function matchDevice(records: DeviceRecord[], query: string): DeviceMatch {
  const exact = records.find((d) => d.pubKey === query);
  if (exact) return { kind: "one", record: exact };
  const q = query.toLowerCase();
  const byFp = records.filter((d) => fingerprint(d.pubKey).startsWith(q));
  if (byFp.length === 1) return { kind: "one", record: byFp[0] };
  if (byFp.length === 0) return { kind: "none" };
  return { kind: "ambiguous", matches: byFp };
}

export type CliAction =
  | { cmd: "devices-list" }
  | { cmd: "devices-remove"; query: string }
  | { cmd: "pair"; name?: string }
  | { cmd: "unknown"; usage: string };

export const CLI_USAGE = [
  "Usage:",
  "  pocketshell-agent devices list",
  "  pocketshell-agent devices remove <pubkey-or-fingerprint>",
  "  pocketshell-agent pair [--name <device-name>]",
].join("\n");

export function parseArgv(argv: string[]): CliAction {
  if (argv[0] === "devices" && argv[1] === "list") return { cmd: "devices-list" };
  if (argv[0] === "devices" && argv[1] === "remove" && argv[2]) return { cmd: "devices-remove", query: argv[2] };
  if (argv[0] === "pair") {
    const i = argv.indexOf("--name");
    return { cmd: "pair", name: i >= 0 ? argv[i + 1] : undefined };
  }
  return { cmd: "unknown", usage: CLI_USAGE };
}
