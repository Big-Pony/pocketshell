/// <reference types="vite/client" />

// Baked at build time by vite.config.ts `define` from app/package.json.
// Equals the agent's AGENT_VERSION: release.sh bumps both package.json files,
// and the app ships embedded in the agent binary, so they can't diverge.
declare const __APP_VERSION__: string;
