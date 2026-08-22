#!/usr/bin/env bun
// 校验 L1（docs/项目信息.md）第六节索引表与 docs/域/*.md 真实状态是否一致。
//
// 为什么需要这个脚本：docs/ 不进版本控制（CLAUDE.md 第 12 条），索引表漂了
// 没有 diff 会提醒。2026-08-17 重构前，表里标称「九域合计 43KB」而真实是
// 96KB，「终端与会话 1.2KB」真实 14KB —— AI 照着表判断「这个域便宜，读一下」，
// 实际吃进十倍的上下文。表一旦骗人，按需读的整套设计就失效了。
//
// 用法：bun run scripts/check-docs-index.ts
// 退出码 0 = 一致；1 = 有漂移（打印逐项差异）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const L1 = "docs/项目信息.md";
const DOMAIN_DIR = "docs/域";
const SIZE_TOLERANCE = 0.1; // 10%：小改动不该逼着人改表

interface IndexRow {
  domain: string;
  path: string;
  sections: string[];
  sizeKb: number;
}

/** 从 L1 第六节抓出索引表的每一行 */
function parseIndexTable(l1: string): IndexRow[] {
  const start = l1.indexOf("## 六、功能域索引");
  if (start < 0) throw new Error(`${L1} 里找不到「## 六、功能域索引」章节`);
  const end = l1.indexOf("\n## ", start + 10);
  const section = l1.slice(start, end < 0 ? undefined : end);

  const rows: IndexRow[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    if (cells[0] === "域" || /^-+$/.test(cells[0])) continue; // 表头与分隔行

    const pathMatch = /`([^`]+)`/.exec(cells[1]);
    if (!pathMatch) continue;
    const sizeMatch = /([\d.]+)\s*KB/i.exec(cells[3]);
    if (!sizeMatch) continue;

    rows.push({
      domain: cells[0],
      path: pathMatch[1],
      // 小节列用 " / " 分隔；括号补充说明（如官网那行）整体保留后再剥
      sections: cells[2]
        .split("/")
        .map((s) => s.trim())
        .filter((s) => s && s !== "（单节）"),
      sizeKb: Number(sizeMatch[1]),
    });
  }
  return rows;
}

/** 读一个域文档的真实 ## 小节名 */
function realSections(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3).trim());
}

const problems: string[] = [];
const l1 = readFileSync(L1, "utf8");
const rows = parseIndexTable(l1);

if (rows.length === 0) problems.push("索引表一行都没解析出来——表格结构可能被改坏了");

// 1) 表里的每一行都要对得上真实文件
for (const row of rows) {
  let size: number;
  try {
    size = statSync(row.path).size;
  } catch {
    problems.push(`${row.domain}：索引表指向 ${row.path}，但该文件不存在`);
    continue;
  }

  const realKb = size / 1024;
  const drift = Math.abs(realKb - row.sizeKb) / realKb;
  if (drift > SIZE_TOLERANCE) {
    problems.push(
      `${row.domain}：表里写 ${row.sizeKb}KB，真实 ${realKb.toFixed(0)}KB（差 ${(drift * 100).toFixed(0)}%）`,
    );
  }

  const real = realSections(row.path);
  const realSet = new Set(real);
  // 代码地图是每个域的固定首节，不要求列进索引表
  for (const s of row.sections) {
    // 允许表里写「概览（其下 ###：…）」这类带补充说明的写法，取括号前的部分比对
    const bare = s.split("（")[0].trim();
    if (!realSet.has(s) && !realSet.has(bare)) {
      problems.push(`${row.domain}：索引表列了小节「${s}」，但 ${row.path} 里没有这个 \`## \` 标题`);
    }
  }
  const listed = new Set(row.sections.map((s) => s.split("（")[0].trim()));
  for (const s of real) {
    if (s === "代码地图") continue;
    if (!listed.has(s)) {
      problems.push(`${row.domain}：${row.path} 有小节「${s}」，但索引表没列出来`);
    }
  }

  // 每个域都该有代码地图
  if (!realSet.has("代码地图")) {
    problems.push(`${row.domain}：${row.path} 缺 \`## 代码地图\` 小节`);
  }
}

// 2) 反向：域目录里的文件都要在表里
const indexed = new Set(rows.map((r) => r.path));
for (const f of readdirSync(DOMAIN_DIR)) {
  if (!f.endsWith(".md")) continue;
  const p = join(DOMAIN_DIR, f);
  if (!indexed.has(p)) {
    problems.push(`${p} 存在，但 L1 第六节索引表没收录它——新域无人取用`);
  }
}

// 3) L1 第五节的 RPC method 清单必须与 rpc-router.ts 的路由表一致
//    （2026-08-17 抽查发现：文档漏了 notify/theme/update/context 共 18 个 method，
//     全是重构前就积下的——这类漂移人眼看不出来，只能机器比对）
try {
  const router = readFileSync("agent/src/rpc-router.ts", "utf8");
  const realMethods = new Set(
    [...router.matchAll(/^ {2}"([a-zA-Z]+\.[a-zA-Z]+)":/gm)].map((m) => m[1]),
  );
  const p5start = l1.indexOf("## 五、WS 协议契约");
  const p5end = l1.indexOf("\n## 六、");
  if (p5start >= 0 && p5end > p5start) {
    const sec = l1.slice(p5start, p5end);
    // 文档里按族分组书写（`fs.*`（10）：`tree`/`read`…），故按族核对数量而非逐名
    const byFamily = new Map<string, number>();
    for (const m of realMethods) {
      const fam = m.split(".")[0];
      byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1);
    }
    const claimedTotal = /当前 (\d+) 个 method/.exec(sec);
    if (!claimedTotal) {
      problems.push("L1 第五节没有「当前 N 个 method」的表述，无法核对 RPC 清单");
    } else if (Number(claimedTotal[1]) !== realMethods.size) {
      problems.push(
        `L1 第五节称「当前 ${claimedTotal[1]} 个 method」，rpc-router.ts 实际 ${realMethods.size} 个`,
      );
    }
    for (const [fam, n] of byFamily) {
      // 只检查文档里显式标了数量的族，如 `fs.*`（10）
      const claimed = new RegExp(`\`${fam}\\.\\*\`（(\\d+)）`).exec(sec);
      if (claimed && Number(claimed[1]) !== n) {
        problems.push(`L1 第五节称 \`${fam}.*\` 有 ${claimed[1]} 个，实际 ${n} 个`);
      }
    }
  }
} catch {
  problems.push("读不到 agent/src/rpc-router.ts，跳过 RPC 清单核对");
}

// 4) 合计大小的表述
const total = rows.reduce((sum, r) => {
  try {
    return sum + statSync(r.path).size;
  } catch {
    return sum;
  }
}, 0);
const totalKb = Math.round(total / 1024);
const claimed = /全部读完约 (\d+)KB/.exec(l1);
if (claimed && Math.abs(Number(claimed[1]) - totalKb) / totalKb > SIZE_TOLERANCE) {
  problems.push(`L1 称「全部读完约 ${claimed[1]}KB」，真实合计 ${totalKb}KB`);
}

if (problems.length > 0) {
  console.error("❌ 文档索引已漂移：\n");
  for (const p of problems) console.error("  · " + p);
  console.error(`\n修正 ${L1} 第六节索引表后重跑。`);
  process.exit(1);
}

console.log(`✅ 索引一致：${rows.length} 个域，合计 ${totalKb}KB，小节名与大小均对得上。`);
