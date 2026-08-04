/// <reference types="vite/client" />

// Baked at build time by vite.config.ts `define` from app/package.json.
// Equals the agent's AGENT_VERSION: release.sh bumps both package.json files,
// and the app ships embedded in the agent binary, so they can't diverge.
declare const __APP_VERSION__: string;

// 演示构建开关。只有 `bun run build:demo` 会把它设成 "1"；真实构建里它是
// undefined，App.svelte 那处三元因此被 tree-shaking 整个剪掉。
interface ImportMetaEnv {
  readonly VITE_POCKETSHELL_DEMO?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
