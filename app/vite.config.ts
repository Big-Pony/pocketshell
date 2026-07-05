import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

export default defineConfig({
  // svelteTesting(): resolves Svelte's "browser" export condition under vitest
  // and auto-cleans mounted components between tests. Required to render .svelte
  // components (with runes/$effect) in the jsdom test environment.
  plugins: [svelte(), svelteTesting()],
  resolve: {
    alias: { "sodium-native": "sodium-javascript" },
  },
  test: {
    environment: "jsdom",
    exclude: ["node_modules", "e2e"],
    setupFiles: ["./vitest-setup.ts"],
  },
});
