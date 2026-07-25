import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
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
      output: {
        // xterm is the largest dependency and only needed by the terminal view;
        // give it its own vendor chunk (cacheable + parallel-downloadable).
        manualChunks(id) {
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
});
