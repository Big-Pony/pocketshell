// Compile-time version, baked from package.json (release.sh bumps it). Bun
// bundles the JSON import into the single-file binary, so the running agent
// always reports the exact version it was built from.
import pkg from "../package.json";

// 【2026-08-28 交付盲区】构建时经 `--define "process.env.PS_BUILD_SHA:…"`
// 注入 git 短 SHA，让版本串变成 `1.21.1-8df0fa2`。原因：PWA 的 SW 按版本桶
// 缓存、注册 URL 是 `/sw.js?v=<版本>`——版本号不变 SW 就永远不换桶。曾有
// 修复在未 bump 版本号的提交里部署到生产 agent，手机端因此一直跑旧包、
// bug「复发」，而日志里毫无痕迹。带上 SHA 后**每个 commit 的部署都换桶**。
// 两边必须同源：前端 vite.config.ts 的 __APP_VERSION__ 用同一 SHA 组合同款
// 后缀（update.ts 的 shouldReloadAfterUpdate 对二者做严格相等比较）。
// 不注入时（bun test / dev）退回纯 semver，测试断言不受影响。
// OTA 比较安全：compareSemver 的 parseInt 在 `-` 处截断，`1.21.1-sha`
// 与 `v1.21.1` 判等、与 `v1.21.2` 判旧。
export const BUILD_SHA: string = process.env.PS_BUILD_SHA ?? "";

export const AGENT_VERSION: string = BUILD_SHA ? `${pkg.version}-${BUILD_SHA}` : pkg.version;
