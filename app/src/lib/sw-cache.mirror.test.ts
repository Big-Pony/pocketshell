// app/src/lib/sw-cache.mirror.test.ts
// SW 缓存策略镜像防漂移。sw-cache.ts 是策略真相（sw-cache.test.ts 覆盖决策表），
// 但**线上跑的是 public/sw.js**——vite 对 public/ 是原样拷贝，不打包也不解析
// import，所以那份规则是手抄的。CLAUDE.md 写着「改一处必须改两处」，此前没有任何
// 机器校验：改了 ts 忘了改 js，单测全绿、线上行为却是旧策略；反过来改了 js 忘了
// 改 ts，测试覆盖的是一套、跑的是另一套——两种都不会有任何报错。
//
// 这里读 public/sw.js 的文本，把三张表和桶名前缀抽出来与 ts 侧比。ts 侧的私有常量
// （CACHE_FIRST_* / NETWORK_FIRST_*）不导出，故同样从源文件文本抽取——比对的是
// 「两份声明」而不是「运行时值 vs 声明」，这正是镜像要防的东西。
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUCKET_PREFIX, cacheStrategy } from "./sw-cache";

const TS = readFileSync(resolve(__dirname, "./sw-cache.ts"), "utf8");
const JS = readFileSync(resolve(__dirname, "../../public/sw.js"), "utf8");

/**
 * 抽出 `名字 = [...]` 或 `名字 = new Set([...])` 里的字符串字面量。
 * ts 侧用 Set、js 侧用数组（indexOf），语法不同但语义是同一张表。
 */
function pathList(src: string, name: string): string[] {
  const m = new RegExp(`\\b${name}\\b[^=]*=\\s*(?:new Set\\()?\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!m) throw new Error(`在源文件里没找到 ${name}`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

function bucketPrefix(src: string): string {
  const m = /BUCKET_PREFIX\s*[:=]\s*"([^"]*)"/.exec(src);
  if (!m) throw new Error("没找到 BUCKET_PREFIX");
  return m[1];
}

const TABLES = ["CACHE_FIRST_PREFIXES", "CACHE_FIRST_EXACT", "NETWORK_FIRST_EXACT"] as const;

test("桶名前缀两侧一致", () => {
  // 前缀漂移的后果最隐蔽：activate 里靠前缀清理旧桶，前缀一变，老桶永远删不掉，
  // 存储配额一路涨到浏览器把整个 origin 的缓存清空。
  expect(bucketPrefix(JS), "public/sw.js 的 BUCKET_PREFIX 与 sw-cache.ts 漂移了").toBe(bucketPrefix(TS));
  expect(bucketPrefix(TS), "sw-cache.ts 的字面量与导出的 BUCKET_PREFIX 对不上").toBe(BUCKET_PREFIX);
});

test("桶名拼接方式两侧一致（前缀 + 版本号，无分隔符）", () => {
  expect(JS).toMatch(/BUCKET\s*=\s*BUCKET_PREFIX\s*\+\s*VERSION/);
  expect(TS).toMatch(/\$\{BUCKET_PREFIX\}\$\{version\}/);
});

for (const name of TABLES) {
  test(`${name} 两侧一致（含顺序）`, () => {
    // 顺序也比：前缀表是顺序匹配的，虽然当前三个前缀互不重叠，但一旦将来出现
    // 包含关系（/assets/ 与 /assets/raw/），顺序就是语义。
    expect(pathList(JS, name), `public/sw.js 的 ${name} 与 sw-cache.ts 漂移了`).toEqual(pathList(TS, name));
  });
}

test("三张表没有交集（同一路径不能既 cache-first 又 network-first）", () => {
  const all = TABLES.flatMap((n) => pathList(TS, n));
  expect([...new Set(all.filter((p, i) => all.indexOf(p) !== i))]).toEqual([]);
});

test("cacheStrategy 的分支顺序两侧一致", () => {
  // 判定顺序决定了重叠时谁赢。抽出三条 return 的先后，两侧必须同序。
  const order = (src: string) =>
    [...src.matchAll(/return\s+"(cache-first|network-first|bypass)"/g)].map((m) => m[1]);
  const tsOrder = order(TS.slice(TS.indexOf("export function cacheStrategy")));
  const jsOrder = order(JS.slice(JS.indexOf("function cacheStrategy"), JS.indexOf("self.addEventListener")));
  expect(tsOrder).toEqual(["network-first", "cache-first", "cache-first", "bypass"]);
  expect(jsOrder, "public/sw.js 的 cacheStrategy 分支顺序与 sw-cache.ts 漂移了").toEqual(tsOrder);
});

test("sw.js 里没有 ts 侧未声明的路径表项（反向漏网）", () => {
  // 只在 js 里加一条（比如临时给某路由开缓存）同样是漂移：单测永远测不到它。
  const tsAll = new Set(TABLES.flatMap((n) => pathList(TS, n)));
  const jsExtra = TABLES.flatMap((n) => pathList(JS, n)).filter((p) => !tsAll.has(p));
  expect(jsExtra, "public/sw.js 有 sw-cache.ts 里没有的路径（不会被单测覆盖）").toEqual([]);
});

test("从 sw.js 的表反推的策略与 ts 的 cacheStrategy 判定一致", () => {
  // 端到端一遍：拿 js 侧声明的路径，去问 ts 侧的真·实现，答案必须对得上。
  for (const p of pathList(JS, "CACHE_FIRST_EXACT")) expect(cacheStrategy(p)).toBe("cache-first");
  for (const p of pathList(JS, "NETWORK_FIRST_EXACT")) expect(cacheStrategy(p)).toBe("network-first");
  for (const p of pathList(JS, "CACHE_FIRST_PREFIXES")) expect(cacheStrategy(`${p}x.bin`)).toBe("cache-first");
});

test("解析器自身有效性自检", () => {
  // 断言几乎全是「两边相等」，正则一旦失配返回空数组就会假阳性全绿。锚一下已知内容。
  expect(pathList(TS, "CACHE_FIRST_PREFIXES")).toEqual(["/assets/", "/fonts/", "/icons/"]);
  expect(pathList(TS, "CACHE_FIRST_EXACT")).toEqual(["/manifest.webmanifest"]);
  expect(pathList(TS, "NETWORK_FIRST_EXACT")).toEqual(["/", "/index.html"]);
  expect(bucketPrefix(TS)).toBe("ps-v");
});

// ---------------------------------------------------------------------------
// push 生命周期的结构性断言（14 期需求 4）
//
// sw.js 里的 push 相关处理没有对应的纯逻辑镜像（它们碰的是 SW 独有的 API：
// pushManager / clients / IndexedDB），而这个文件**无构建、无类型检查**——
// 拼写错误不会被任何工具发现。所以只能做结构性断言：至少保证这些事件处理
// 不会在某次重构中被整个删掉，以及那条"不许直接发 HTTP"的安全约束不被破坏。
// ---------------------------------------------------------------------------

test("sw.js 保留 push 生命周期的三个事件处理", () => {
  for (const evt of ["push", "notificationclick", "pushsubscriptionchange"]) {
    expect(JS, `sw.js 缺 ${evt} 处理`).toContain(`addEventListener("${evt}"`);
  }
});

test("pushsubscriptionchange 不直接发 HTTP 给 agent（须走已认证通道）", () => {
  // SW 拿不到页面的 Noise 通道。让它自己发 HTTP 就要新增一条无认证的公网
  // 路由，正是 VULN-001 的形状（公网可零认证取到配对串）。
  const block = JS.slice(JS.indexOf('addEventListener("pushsubscriptionchange"'));
  expect(block).not.toContain("fetch(");
});

test("pushsubscriptionchange 走 postMessage + IndexedDB 两级降级", () => {
  const block = JS.slice(JS.indexOf('addEventListener("pushsubscriptionchange"'));
  expect(block, "一级降级：转发给活动页面").toContain("postMessage");
  expect(block, "二级降级：无页面时落 IndexedDB").toContain("stashPendingSubscription");
});

test("SW 与页面对 IndexedDB 待补报槽位的命名逐字一致", () => {
  // sw.js 写、web-push-client.ts 读，两边各写各的字面量。名字一漂移，写进去的
  // 订阅永远没人读——而且不会有任何报错，只是推送一直修不好。
  const CLIENT = readFileSync(resolve(__dirname, "./web-push-client.ts"), "utf8");
  const lit = (src: string, re: RegExp) => {
    const m = re.exec(src);
    if (!m) throw new Error(`没找到 ${re}`);
    return m[1];
  };
  const dbJs = lit(JS, /PENDING_DB\s*=\s*"([^"]*)"/);
  const storeJs = lit(JS, /PENDING_STORE\s*=\s*"([^"]*)"/);
  const keyJs = lit(JS, /PENDING_KEY\s*=\s*"([^"]*)"/);
  // 那三个常量确实是写入路径上真正被用到的（否则上面抽的就是死代码）
  expect(JS).toMatch(/indexedDB\.open\(PENDING_DB,\s*1\)/);
  expect(JS).toMatch(/objectStore\(PENDING_STORE\)\.put\([^,]+,\s*PENDING_KEY\)/);
  expect(dbJs).toBe("ps-push");
  expect(storeJs).toBe("pending");
  expect(keyJs).toBe("sub");
  expect(CLIENT, "客户端读的库名与 sw.js 写的不一致").toContain(`indexedDB.open("${dbJs}", 1)`);
  expect(CLIENT, "客户端读的 store 名与 sw.js 写的不一致").toContain(`transaction("${storeJs}"`);
  expect(CLIENT, "客户端读的 key 与 sw.js 写的不一致").toContain(`store.get("${keyJs}")`);
});

test("sw.js 里的 IndexedDB 用法拼写正确（无构建无类型检查，只能靠这里）", () => {
  // 这几个都是 IDB 里最容易拼错、且错了不会抛而是静默失效的名字。
  const block = JS.slice(JS.indexOf("function openPendingDb"));
  expect(block).toContain("onupgradeneeded");     // 少个 e 就永远建不出 store
  expect(block).toContain("createObjectStore");
  expect(block).toMatch(/transaction\([^,]+,\s*"readwrite"\)/); // 拼错模式会抛
  expect(block).toContain("oncomplete");
  // db.transaction/objectStore 是同步 API，误加 await 会拿到非 Promise 值而
  // 静默变成 undefined 链——这条断言钉住正确形态。
  expect(block).not.toMatch(/await\s+\w+\.transaction\(/);
});

test("诊断推送仍然 showNotification（否则算静默推送违规）", () => {
  // 部分浏览器要求每次 push 都显示通知，累计违规会吊销订阅权限。
  const push = JS.slice(JS.indexOf('addEventListener("push"'), JS.indexOf('addEventListener("notificationclick"'));
  const diag = push.slice(push.indexOf("d.diag"));
  expect(diag, "诊断推送分支里必须 showNotification").toContain("showNotification");
  expect(diag, "诊断推送要回报给页面").toContain("push-diag-received");
});
