import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { resolve } from "node:path";
import { cpSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import pkg from "./package.json" with { type: "json" };

// 【2026-08-28 交付盲区】版本串带 git 短 SHA：SW 按版本桶缓存、注册 URL 是
// `/sw.js?v=<版本>`——版本号不变就永远不换桶。曾有修复在未 bump 版本号的
// 提交里部署到生产 agent，手机端因此一直跑旧缓存包、bug「复发」且日志零
// 痕迹。带上 SHA 后每个 commit 的部署都会换桶。必须与 agent 侧
// AGENT_VERSION（version.ts，经 --define 注入同一 SHA）同源同格式——
// update.ts 的 shouldReloadAfterUpdate 对二者做严格相等比较。
// git 不可用时（如 tarball 构建）退回纯 semver，与 agent 侧的退化一致。
const gitSha = (() => {
  try { return execSync("git rev-parse --short HEAD").toString().trim(); } catch { return ""; }
})();

// 演示专用静态资产（二维码、预览 fixture）单独放 public-demo/，**不进 public/**。
// 理由：vite 会无条件把整个 publicDir 拷进 dist，publicDir 又只能指一个目录——
// 放在 public/ 里的话，真实构建也会带上它们，进而被 agent 的 gen-embedded.ts
// 嵌进每个发布的二进制。rollupOptions.input 的门控只管 JS 模块图，管不到这里。
function demoAssets(): Plugin {
  return {
    name: "pocketshell-demo-assets",
    apply: "build",
    closeBundle() {
      const src = resolve(import.meta.dirname, "public-demo");
      if (existsSync(src)) cpSync(src, resolve(import.meta.dirname, "dist"), { recursive: true });
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
    // SHA 后缀的理由见文件头——缺了它，未 bump 版本号的部署永远到不了 PWA。
    define: {
      __APP_VERSION__: JSON.stringify(gitSha ? `${pkg.version}-${gitSha}` : pkg.version),
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
      // 显式钉住「构建前清空 dist」（2026-08-28）：vite 默认只在 outDir 位于
      // root 内时才清空，一旦将来有人把 outDir 挪走，旧 chunk 会静默混进
      // gen-embedded 打进二进制。显式写出来，行为不随默认值漂移。
      emptyOutDir: true,
      rollupOptions: {
        input: isDemo
          ? {
              app: resolve(import.meta.dirname, "index.html"),
              demo: resolve(import.meta.dirname, "demo.html"),
            }
          : resolve(import.meta.dirname, "index.html"),
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
