import { test, expect } from "bun:test";
import { checkLatest } from "./update-check";

function fakeFetch(status: number, json: unknown): typeof fetch {
  return (async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => json }) as Response) as unknown as typeof fetch;
}

test("disabled repo returns disabled/no-apply", async () => {
  const r = await checkLatest({ repo: null, current: "0.3.0" });
  expect(r.hasUpdate).toBe(false);
  expect(r.canApply).toBe(false);
  expect(r.reason).toBe("disabled");
});

test("newer release yields hasUpdate + canApply on supported platform", async () => {
  const r = await checkLatest({
    repo: "x/y", current: "0.3.0", platform: "linux", arch: "x64",
    fetchImpl: fakeFetch(200, { tag_name: "v0.4.0", body: "notes", published_at: "2026-07-19T00:00:00Z" }),
  });
  expect(r.latest).toBe("0.4.0");
  expect(r.hasUpdate).toBe(true);
  expect(r.canApply).toBe(true);
  expect(r.notes).toBe("notes");
});

test("same version → no update", async () => {
  const r = await checkLatest({
    repo: "x/y", current: "0.4.0", platform: "linux", arch: "x64",
    fetchImpl: fakeFetch(200, { tag_name: "v0.4.0", body: "", published_at: null }),
  });
  expect(r.hasUpdate).toBe(false);
});

test("unsupported platform can check but not apply", async () => {
  const r = await checkLatest({
    repo: "x/y", current: "0.3.0", platform: "win32", arch: "x64",
    fetchImpl: fakeFetch(200, { tag_name: "v0.4.0", body: "", published_at: null }),
  });
  expect(r.hasUpdate).toBe(true);
  expect(r.canApply).toBe(false);
  expect(r.reason).toBe("unsupported_platform");
});

test("network failure is silent (no update, no throw)", async () => {
  const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const r = await checkLatest({ repo: "x/y", current: "0.3.0", platform: "linux", arch: "x64", fetchImpl: boom });
  expect(r.hasUpdate).toBe(false);
  expect(r.latest).toBeNull();
  expect(r.reason).toBe("no_release_info");
});
