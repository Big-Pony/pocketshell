// git.review 的纯解析层：字符串 -> 结构。不 spawn git、不碰文件系统，
// 因此可以脱离真仓库密集单测（真仓库的编排逻辑在 git-review.ts）。

export interface NumstatRow { path: string; add: number; del: number; binary: boolean }

/**
 * 从 `git diff --numstat` 的 stdout 解析出每文件增删数。
 * 二进制文件 git 回 "-\t-\tpath"，必须与 "0\t0" 区分开——前者是"没法算"，
 * 后者是"真的没变"，UI 上要显示不同文案。
 */
export function parseNumstat(stdout: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [addS, delS, rawPath] = line.split("\t");
    if (rawPath === undefined) continue;
    const binary = addS === "-" && delS === "-";
    rows.push({
      path: renamedTarget(rawPath),
      add: binary ? 0 : Number(addS) || 0,
      del: binary ? 0 : Number(delS) || 0,
      binary,
    });
  }
  return rows;
}

/**
 * --find-renames 下 git 用两种形式表达重命名：
 *   "old.ts => new.ts"          （无公共前缀）
 *   "src/{old => new}.ts"       （有公共前缀，紧凑形式）
 * 两种都取新路径——面板要展示的是文件现在在哪。
 */
function renamedTarget(raw: string): string {
  const brace = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) return (brace[1] + brace[3] + brace[4]).replace(/\/\//g, "/");
  const arrow = raw.split(" => ");
  return arrow.length === 2 ? arrow[1] : raw;
}

export interface PorcelainRow { path: string; x: string; y: string; isDir: boolean }

/**
 * `git status --porcelain` 每行是 "XY path"：X 是暂存区状态、Y 是工作区状态。
 * 未跟踪目录 git 只回一个以 "/" 结尾的条目（不逐个列文件），这里如实标出，
 * 上层据此决定不展开——一个新建的 node_modules/ 会瞬间打爆预算。
 */
export function parsePorcelain(stdout: string): PorcelainRow[] {
  const rows: PorcelainRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const path = line.slice(3);
    if (!path) continue;
    rows.push({ path, x, y, isDir: path.endsWith("/") });
  }
  return rows;
}

/**
 * 文件级暂存标记。X 非空非 "?" 即进过暂存区；X 与 Y 同时非空即部分暂存
 * （add 之后又改了）。行级归属不做——见 spec §3.2。
 */
export function stagedMark(x: string, y: string): "full" | "partial" | undefined {
  if (x === "?" || x === " " || x === "") return undefined;
  const dirtyWorktree = y !== " " && y !== "";
  return dirtyWorktree ? "partial" : "full";
}

export interface DiffHunk { header: string; lines: { kind: "add" | "del" | "ctx"; text: string }[] }

/**
 * 把一整份多文件 diff 按 "diff --git a/X b/Y" 头拆成 per-file hunks。
 *
 * 路径取 b/ 侧（新路径）：重命名时 a/ 是旧名，面板要显示文件现在在哪。
 * 用 " b/" 定位而不是空格分割——路径可以含空格。
 */
export function splitDiffByFile(stdout: string): Map<string, DiffHunk[]> {
  const out = new Map<string, DiffHunk[]>();
  let hunks: DiffHunk[] | null = null;
  let cur: DiffHunk | null = null;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice("diff --git ".length);
      const at = rest.indexOf(" b/");
      const path = at >= 0 ? rest.slice(at + 3) : rest;
      hunks = [];
      cur = null;
      out.set(path, hunks);
      continue;
    }
    if (!hunks) continue;                       // diff --git 之前的噪声
    if (line.startsWith("@@")) { cur = { header: line, lines: [] }; hunks.push(cur); continue; }
    if (!cur) continue;                          // 文件头（index/---/+++/new file mode）
    if (line.startsWith("+")) cur.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) cur.lines.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith("\\")) continue;    // "\ No newline at end of file"
    else cur.lines.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return out;
}

/**
 * 未跟踪文件的 diff 天然就是"每一行都是新增"，直接合成而不 spawn git。
 *
 * 不走 `git diff --no-index` 的三个理由（spec §3.1）：
 *   a) 那样 N 个新文件就是 N 次 spawn，破坏「spawn 次数与规模无关」；
 *   b) --no-index 有差异时**退出码为 1**，与 runGit 的 ok 判据冲突，
 *      后来者极易把它"修"回 ok 判断从而静默丢掉所有新文件；
 *   c) 合成是纯函数，能脱离 git 单测。
 *
 * `add` 回的是**真实总行数**而非截断后的行数——UI 上的 "+55" 要说实话。
 */
export function synthAddedHunk(content: string, cap: number): { hunks: DiffHunk[]; add: number; truncated: boolean } {
  if (content === "") return { hunks: [], add: 0, truncated: false };
  const all = content.split("\n");
  // 末尾换行会切出一个空串尾元素，它不是一行内容。
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const add = all.length;
  const shown = all.slice(0, cap);
  return {
    hunks: [{
      header: `@@ -0,0 +1,${add} @@`,
      lines: shown.map((text) => ({ kind: "add" as const, text })),
    }],
    add,
    truncated: add > cap,
  };
}

/** 单文件 diff 行数上限（含 ctx）。超出即降级为 oversize，不传正文。 */
export const FILE_LINE_CAP = 1500;
/** 一次响应的总行数预算。保证响应体积有硬上界，rpcChunk 不会被撑爆。 */
export const TOTAL_LINE_BUDGET = 8000;

export interface Sized { path: string; add: number; del: number }

/**
 * 决定哪些文件带正文、哪些降级为 oversize。
 *
 * **按体量从小到大装填**是有意的：小文件通常是真正要审的逻辑改动，
 * lock 文件、生成物之类天然排在后面被挤掉。按输入顺序装的话，一个
 * 排在前面的 3000 行 lock 会把后面所有小文件的预算吃光。
 *
 * 同体量时按路径排序，保证同一份改动每次得到相同结果（可复现，
 * 也让测试不依赖 Map/对象的枚举顺序）。
 */
export function planBudget<T extends Sized>(
  rows: T[], budget: number, cap: number,
): { keep: Set<string>; truncated: boolean } {
  const sorted = [...rows].sort((a, b) => {
    const sa = a.add + a.del, sb = b.add + b.del;
    return sa !== sb ? sa - sb : a.path.localeCompare(b.path);
  });

  const keep = new Set<string>();
  let truncated = false;
  let spent = 0;
  for (const r of sorted) {
    const size = r.add + r.del;
    if (size > cap || spent + size > budget) { truncated = true; continue; }
    keep.add(r.path);
    spent += size;
  }
  return { keep, truncated };
}
