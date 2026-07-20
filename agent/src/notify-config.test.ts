import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { defaultNotifyConfig, loadNotifyConfig, saveNotifyConfig } from "./notify-config";

test("default has all channels off", () => {
  const c = defaultNotifyConfig();
  expect(c.tools).toEqual({ claude: false, codex: false, opencode: false });
  expect(c.webPush).toBe(false);
  expect(c.includeSummary).toBe(true);
  expect(c.dedupeMs).toBe(10000);
  expect(c.webhooks).toEqual([]);
});

test("save then load round-trips", () => {
  const f = join(tmpdir(), `nc-${process.pid}-${Math.round(performance.now())}.json`);
  const c = defaultNotifyConfig();
  c.webPush = true;
  c.webhooks.push({ id: "a", name: "team", kind: "feishu", url: "https://x", enabled: true, secret: "s" });
  saveNotifyConfig(f, c);
  expect(loadNotifyConfig(f)).toEqual(c);
  rmSync(f, { force: true });
});

test("missing file returns default", () => {
  expect(loadNotifyConfig(join(tmpdir(), "nope-nc.json"))).toEqual(defaultNotifyConfig());
});
