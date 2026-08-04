import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { resolve } from "node:path";
import { cpSync, existsSync } from "node:fs";
import pkg from "./package.json" with { type: "json" };

// 演示专用静态资产（二维码、预览 fixture）单独放 public-demo/，**不进 public/**。
// 理由：vite 会无条件把整个 publicDir 拷进 dist，publicDir 又只能指一个目录——
// 放在 public/ 里的话，真实构建也会带上它们，进而被 agent 的 gen-embedded.ts
// 嵌进每个发布的二进制。rollupOptions.input 的门控只管 JS 模块图，管不到这里。
function demoAssets(): Plugin {
  return {
    name: "pocketshell-demo-assets",
    apply: "build",
    closeBundle() {
      const src = resolve(__dirname, "public-demo");
      if (existsSync(src)) cpSync(src, resolve(__dirname, "dist"), { recursive: true });
    },
  };
}

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
    // demoAssets() 只在演示构建里挂上：真实构建因此连 public-demo/ 都不看一眼。
    plugins: [svelte(), svelteTesting(), ...(isDemo ? [demoAssets()] : [])],
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
