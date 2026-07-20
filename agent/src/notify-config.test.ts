import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { defaultNotifyConfig, loadNotifyConfig, saveNotifyConfig, sanitizeNotifyConfig } from "./notify-config";

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

test("sanitizeNotifyConfig corrects malformed dedupeMs to default", () => {
  const c1 = sanitizeNotifyConfig({ dedupeMs: NaN });
  expect(c1.dedupeMs).toBe(10000);
  const c2 = sanitizeNotifyConfig({ dedupeMs: Infinity });
  expect(c2.dedupeMs).toBe(10000);
  const c3 = sanitizeNotifyConfig({ dedupeMs: "5000" });
  expect(c3.dedupeMs).toBe(10000);
  const c4 = sanitizeNotifyConfig({ dedupeMs: 5000 });
  expect(c4.dedupeMs).toBe(5000);
});

test("sanitizeNotifyConfig corrects malformed webhooks to empty array", () => {
  const c1 = sanitizeNotifyConfig({ webhooks: "not-an-array" });
  expect(c1.webhooks).toEqual([]);
  const c2 = sanitizeNotifyConfig({ webhooks: null });
  expect(c2.webhooks).toEqual([]);
  const c3 = sanitizeNotifyConfig({});
  expect(c3.webhooks).toEqual([]);
  const wh = [{ id: "a", name: "n", kind: "slack", url: "https://x", enabled: true }];
  const c4 = sanitizeNotifyConfig({ webhooks: wh });
  expect(c4.webhooks).toEqual(wh);
});
