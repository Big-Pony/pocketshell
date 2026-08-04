// Post-build (demo only): swap the two entry HTMLs.
//
// vite 多页构建按源文件名产出 dist/index.html（app）与 dist/demo.html（展台）。
// 而 Cloudflare Pages 把 dist/index.html 服务在根路径——桌面访客打开
// demo.pocketshell.net 会直接落到 app，整个双形态分流失效。
//
// 故改名：index.html → app.html（先做，否则被覆盖），demo.html → index.html。
// 两个 HTML 引用的资源路径都是绝对的（/assets/…），不随文件位置变化。
//
// 刻意不用 _redirects 做 rewrite：Pages 对静态资源精确匹配与 200 改写的优先级
// 存在不确定性，改名是确定的。
import { renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dir, "../dist");
const appHtml = join(dist, "index.html");
const demoHtml = join(dist, "demo.html");

if (!existsSync(demoHtml)) {
  console.error("[rename-demo-dist] dist/demo.html 不存在 —— 这不是一次 demo 构建？");
  process.exit(1);
}

renameSync(appHtml, join(dist, "app.html"));
renameSync(demoHtml, appHtml);
console.log("[rename-demo-dist] index.html -> app.html, demo.html -> index.html");
