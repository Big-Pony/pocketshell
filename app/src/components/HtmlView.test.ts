import { render } from "@testing-library/svelte";
import { describe, it, expect } from "vitest";
import HtmlView from "./HtmlView.svelte";

describe("HtmlView", () => {
  it("renders a script-sandboxed iframe without same-origin", () => {
    const { container } = render(HtmlView, { props: { src: "http://agent/preview/T/index.html" } });
    const f = container.querySelector("iframe")!;
    expect(f.getAttribute("src")).toBe("http://agent/preview/T/index.html");
    const sb = f.getAttribute("sandbox") ?? "";
    expect(sb).toContain("allow-scripts");
    expect(sb).not.toContain("allow-same-origin");
  });
});
