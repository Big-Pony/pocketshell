// A6 DeviceRegistry — persistent paired-device table at <keyDir>/devices.json.
// Env allowlist lives in config.authorizedKeys and is unioned at authorize()
// time (server.ts), NOT stored here. Atomic write (tmp + rename), mode 0600.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DeviceRecord { pubKey: string; name: string; addedAt: string; lastSeen: string | null; }
export interface DeviceRegistry {
  list(): DeviceRecord[];
  has(pub: string): boolean;
  add(pub: string, name: string): void;
  remove(pub: string): boolean;
  touch(pub: string): void;
}

export function loadDeviceRegistry(file: string, now: () => number = () => Date.now()): DeviceRegistry {
  let devices: DeviceRecord[] = [];
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j && Array.isArray(j.devices)) devices = j.devices;
    } catch { devices = []; }
  }
  const persist = () => {
    const tmp = join(dirname(file), `.devices.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ v: 1, devices }), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const iso = () => new Date(now()).toISOString();
  return {
    list: () => devices.map((d) => ({ ...d })),
    has: (pub) => devices.some((d) => d.pubKey === pub),
    add: (pub, name) => {
      const ex = devices.find((d) => d.pubKey === pub);
      if (ex) { ex.name = name; }
      else { devices.push({ pubKey: pub, name, addedAt: iso(), lastSeen: null }); }
      persist();
    },
    remove: (pub) => {
      const n = devices.length;
      devices = devices.filter((d) => d.pubKey !== pub);
      if (devices.length === n) return false;
      persist();
      return true;
    },
    touch: (pub) => {
      const d = devices.find((x) => x.pubKey === pub);
      if (d) { d.lastSeen = iso(); persist(); }
    },
  };
}
