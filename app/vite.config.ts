import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { resolve } from "node:path";
import pkg from "./package.json" with { type: "json" };

export default defineConfig(({ mode }) => {
  // 演示构建（bun run build:demo）多一个入口：demo.html 展台页。
  // 真实构建**根本不把它放进 input**，故整棵 src/demo/** 连同展台组件不可达
  // ——纯净性由构建配置结构性保证，purity.test.ts 只是第二道。
  const isDemo = mode === "demo";
  return {
    // Bake the app version so the service worker can namespace its cache bucket
    // (see src/lib/sw-cache.ts). Kept in lockstep with the agent by release.sh.
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    // svelteTesting(): resolves Svelte's "browser" export condition under vitest
    // and auto-cleans mounted components between tests. Required to render .svelte
    // components (with runes/$effect) in the jsdom test environment.
    plugins: [svelte(), svelteTesting()],
    resolve: {
      alias: { "sodium-native": "sodium-javascript" },
    },
    build: {
      rollupOptions: {
        input: isDemo
          ? {
              app: resolve(__dirname, "index.html"),
              demo: resolve(__dirname, "demo.html"),
            }
          : resolve(__dirname, "index.html"),
        output: {
          manualChunks(id: string) {
            if (id.includes("node_modules/@xterm/")) return "xterm";
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      exclude: ["node_modules", "e2e"],
      setupFiles: ["./vitest-setup.ts"],
    },
  };
});
