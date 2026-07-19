import { render, waitFor } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import MarkdownView from "./MarkdownView.svelte";

describe("MarkdownView", () => {
  it("renders markdown, rewrites local images, strips scripts", async () => {
    const buildImageUrl = vi.fn(async (rel: string) => `http://agent/preview/T/${rel}`);
    const { container } = render(MarkdownView, {
      props: {
        source: "# Hi\n\n![a](./img/a.png)\n\n<script>window.x=1<\/script>\n\n[l](https://e.com)",
        mdFileDir: "/root/proj/docs",
        buildImageUrl,
        onFail: () => {},
      },
    });
    await waitFor(() => expect(container.querySelector("h1")?.textContent).toContain("Hi"));
    await waitFor(() => {
      const img = container.querySelector("img");
      expect(img?.getAttribute("src")).toBe("http://agent/preview/T/img/a.png");
    });
    // html:false escapes raw HTML to inert text, so the <script> never becomes a
    // live element (stronger than DOMPurify removal — it can never execute).
    expect(container.querySelector(".md-body script")).toBeNull();
  });
});
