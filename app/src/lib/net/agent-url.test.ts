import { test, expect } from "vitest";
import { defaultAgentUrl } from "./agent-url";

test("dev mode uses ws://hostname:8722 regardless of page protocol", () => {
  expect(defaultAgentUrl(true, { protocol: "http:", host: "localhost:5173", hostname: "localhost" }))
    .toBe("ws://localhost:8722");
  expect(defaultAgentUrl(true, { protocol: "https:", host: "localhost:5173", hostname: "localhost" }))
    .toBe("ws://localhost:8722");
});

test("production over http uses ws:// with same host/port", () => {
  expect(defaultAgentUrl(false, { protocol: "http:", host: "192.168.1.5:8722", hostname: "192.168.1.5" }))
    .toBe("ws://192.168.1.5:8722");
});

test("production over https uses wss:// with same host/port", () => {
  expect(defaultAgentUrl(false, { protocol: "https:", host: "c1.cf-blog.com", hostname: "c1.cf-blog.com" }))
    .toBe("wss://c1.cf-blog.com");
});
