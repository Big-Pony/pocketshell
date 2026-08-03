import { describe, test, expect } from "vitest";

// 顶栏实例名的渲染规则做成纯函数便于断言：组件只负责把它塞进 span。
import { brandPrefix } from "./lib/ui/instance-name";

describe("brandPrefix", () => {
  test("returns the name plus separator when set", () => {
    expect(brandPrefix("开发")).toBe("开发 · ");
  });

  test("returns an empty string when unset, so the topbar renders exactly as before", () => {
    expect(brandPrefix(null)).toBe("");
    expect(brandPrefix(undefined)).toBe("");
    expect(brandPrefix("")).toBe("");
    expect(brandPrefix("   ")).toBe("");
  });

  test("truncates an over-long name so it cannot push the topbar controls off-screen", () => {
    expect(brandPrefix("非常非常非常非常长的服务器名字啊啊啊")).toBe("非常非常非常非常 · ");
  });
});
