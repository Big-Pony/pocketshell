import { describe, it, expect } from "vitest";
import { cacheStrategy, bucketName, staleBuckets, BUCKET_PREFIX } from "./sw-cache";

describe("cacheStrategy", () => {
  it("hashed assets are cache-first", () => {
    expect(cacheStrategy("/assets/index-B8-9FxKW.js")).toBe("cache-first");
    expect(cacheStrategy("/assets/xterm-B9kgwzi6.js")).toBe("cache-first");
    expect(cacheStrategy("/assets/index-c8Q2kIWj.css")).toBe("cache-first");
  });

  it("fonts, icons and manifest are cache-first", () => {
    expect(cacheStrategy("/fonts/JetBrainsMono-Regular.woff2")).toBe("cache-first");
    expect(cacheStrategy("/icons/icon-192.png")).toBe("cache-first");
    expect(cacheStrategy("/icons/icon.svg")).toBe("cache-first");
    expect(cacheStrategy("/manifest.webmanifest")).toBe("cache-first");
  });

  it("the shell is network-first", () => {
    expect(cacheStrategy("/")).toBe("network-first");
    expect(cacheStrategy("/index.html")).toBe("network-first");
  });

  it("preview routes never touch the cache (token auth expires)", () => {
    expect(cacheStrategy("/preview/abc123/a.png")).toBe("bypass");
    expect(cacheStrategy("/preview/abc123/nested/dir/page.html")).toBe("bypass");
  });

  it("admin routes bypass", () => {
    expect(cacheStrategy("/admin")).toBe("bypass");
    expect(cacheStrategy("/admin-api/devices")).toBe("bypass");
  });

  it("sw.js itself bypasses so the browser can always revalidate it", () => {
    expect(cacheStrategy("/sw.js")).toBe("bypass");
  });

  it("unknown paths default to bypass (allowlist, not denylist)", () => {
    expect(cacheStrategy("/internal/notify")).toBe("bypass");
    expect(cacheStrategy("/some/future/route")).toBe("bypass");
    expect(cacheStrategy("/assets")).toBe("bypass"); // no trailing slash: not the assets dir
  });
});

describe("bucketName", () => {
  it("prefixes the version", () => {
    expect(bucketName("1.0.1")).toBe("ps-v1.0.1");
    expect(BUCKET_PREFIX).toBe("ps-v");
  });
});

describe("staleBuckets", () => {
  it("returns every ps-v bucket except the current one", () => {
    const keys = ["ps-v1.0.0", "ps-v1.0.1", "ps-v0.9.0"];
    expect(staleBuckets(keys, "1.0.1").sort()).toEqual(["ps-v0.9.0", "ps-v1.0.0"]);
  });

  it("never touches buckets owned by anything else", () => {
    const keys = ["ps-v1.0.0", "workbox-precache", "some-other-app", "ps-legacy"];
    expect(staleBuckets(keys, "1.0.1")).toEqual(["ps-v1.0.0"]);
  });

  it("returns empty when only the current bucket exists", () => {
    expect(staleBuckets(["ps-v1.0.1"], "1.0.1")).toEqual([]);
  });
});
