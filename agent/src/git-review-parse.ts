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
