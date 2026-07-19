import { describe, it, expect } from "vitest";
import { previewKind, previewOrigin, previewUrl, relFromBase, resolveMdImageSrc } from "./preview";

describe("previewKind", () => {
  it("classifies by extension", () => {
    expect(previewKind("/x/a.png")).toBe("image");
    expect(previewKind("/x/a.SVG")).toBe("image");
    expect(previewKind("/x/a.md")).toBe("markdown");
    expect(previewKind("/x/a.markdown")).toBe("markdown");
    expect(previewKind("/x/a.html")).toBe("html");
    expect(previewKind("/x/a.ts")).toBe("code");
    expect(previewKind("/x/Makefile")).toBe("code");
  });
});

describe("previewOrigin", () => {
  it("derives http origin from the ws agent url (any port)", () => {
    expect(previewOrigin("ws://localhost:8722")).toBe("http://localhost:8722");
    expect(previewOrigin("ws://127.0.0.1:8799")).toBe("http://127.0.0.1:8799");
  });
  it("maps wss → https (prod same origin)", () => {
    expect(previewOrigin("wss://mac.cf-blog.com")).toBe("https://mac.cf-blog.com");
  });
  it("falls back to the raw string on unparseable input", () => {
    expect(previewOrigin("not-a-url")).toBe("not-a-url");
  });
});

describe("previewUrl", () => {
  it("joins origin/token/relpath, encoding segments", () => {
    expect(previewUrl("https://h", "Tok", "sub dir/a b.png"))
      .toBe("https://h/preview/Tok/sub%20dir/a%20b.png");
  });
});

describe("relFromBase", () => {
  it("returns posix relative path", () => {
    expect(relFromBase("/root/proj", "/root/proj/docs/a.png")).toBe("docs/a.png");
    expect(relFromBase("/root/proj", "/root/proj/a.png")).toBe("a.png");
  });
});

describe("resolveMdImageSrc", () => {
  it("resolves relative against the md file dir", () => {
    expect(resolveMdImageSrc("/root/proj/docs", "./img/a.png")).toEqual({ relToDir: "img/a.png" });
    expect(resolveMdImageSrc("/root/proj/docs", "../assets/b.jpg")).toEqual({ relToDir: "../assets/b.jpg" });
  });
  it("skips remote and data URIs", () => {
    expect(resolveMdImageSrc("/root/proj/docs", "https://x/a.png")).toBeNull();
    expect(resolveMdImageSrc("/root/proj/docs", "data:image/png;base64,AAAA")).toBeNull();
  });
});
