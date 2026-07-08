// P1 git service. All READ-ONLY: log / branches / status. Spawns the system git
// (same binary the terminal + Claude use, so panel and terminal never diverge).
// No isomorphic-git — a JS reimplementation would be a second source of truth.
export interface Commit {
  hash: string; msg: string; author: string; when: string;
  files: { path: string; add: number; del: number }[];
}

export function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  // core.quotepath=false: keep non-ASCII (CJK) paths verbatim in UTF-8 instead
  // of git's default C-style octal escaping ("\346..."), which the file/git
  // panel would otherwise render as mojibake.
  const res = Bun.spawnSync(["git", "-c", "core.quotepath=false", "-C", cwd, ...args]);
  return {
    ok: res.exitCode === 0,
    stdout: new TextDecoder().decode(res.stdout),
    stderr: new TextDecoder().decode(res.stderr),
  };
}

export function isRepo(cwd: string): boolean {
  const r = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

const US = "\x1f"; // field separator
const RS = "\x1e"; // record separator

export function gitLog(cwd: string, limit: number, query?: string): { commits: Commit[] } {
  if (!isRepo(cwd)) throw new Error("not_a_repo");
  const args = ["log", `--max-count=${limit}`, "--numstat", "--date=relative",
    `--pretty=format:${RS}%H${US}%an${US}%ad${US}%s`];
  if (query) args.push(`--grep=${query}`);
  const r = runGit(cwd, args);
  if (!r.ok) throw new Error(r.stderr.trim() || "git log failed");

  const commits: Commit[] = [];
  // Each commit is prefixed with RS (record separator) via the pretty format, so
  // a commit with no numstat block (empty/merge commit) still delimits cleanly.
  // Splitting on blank lines instead would merge such a commit into the next
  // commit's block — dropping it and misattributing its numstat rows.
  for (const rec of r.stdout.split(RS)) {
    const lines = rec.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    const [hash, author, when, msg] = lines[0].split(US);
    if (hash === undefined) continue;
    const files: Commit["files"] = [];
    for (let i = 1; i < lines.length; i++) {
      const [addS, delS, path] = lines[i].split("\t");
      if (path === undefined) continue;
      files.push({ path, add: addS === "-" ? 0 : Number(addS) || 0, del: delS === "-" ? 0 : Number(delS) || 0 });
    }
    commits.push({ hash, author, when, msg, files });
  }
  return { commits };
}

export function gitBranches(cwd: string): { current: string; branches: string[] } {
  if (!isRepo(cwd)) throw new Error("not_a_repo");
  const cur = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const list = runGit(cwd, ["branch", "--format=%(refname:short)"]);
  const branches = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  return { current: cur.stdout.trim(), branches };
}

export function mapStatusChar(xy: string): "M" | "A" | "D" | "?" {
  if (xy === "??") return "?";
  for (const ch of xy) {
    if (ch === "M") return "M";
    if (ch === "A") return "A";
    if (ch === "D") return "D";
  }
  return "?";
}

export function gitStatus(cwd: string): { files: { path: string; status: "M" | "A" | "D" | "?" }[] } {
  if (!isRepo(cwd)) throw new Error("not_a_repo");
  const r = runGit(cwd, ["status", "--porcelain"]);
  if (!r.ok) throw new Error(r.stderr.trim() || "git status failed");
  const files: { path: string; status: "M" | "A" | "D" | "?" }[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    const path = line.slice(3);
    if (!path) continue;
    files.push({ path, status: mapStatusChar(xy) });
  }
  return { files };
}
