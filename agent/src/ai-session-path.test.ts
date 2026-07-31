import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { kimiSessionPath, claudeSessionPath, codexSessionPath, readTail } from "./ai-session-path";

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), "ps-ai-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  return { home, restore: () => { process.env.HOME = prev; } };
}

test("kimiSessionPath uses md5(cwd) as parent dir", () => {
  const { home, restore } = tmpHome();
  try {
    const cwd = "/home/user/project";
    const md5 = createHash("md5").update(cwd).digest("hex");
    expect(kimiSessionPath(cwd, "s1")).toBe(join(home, ".kimi", "sessions", md5, "s1", "wire.jsonl"));
  } finally { restore(); }
});

test("readTail reads the last 64KB of a kimi session file", async () => {
  const { home, restore } = tmpHome();
  try {
    const cwd = "/x";
    const md5 = createHash("md5").update(cwd).digest("hex");
    const dir = join(home, ".kimi", "sessions", md5, "s1");
    mkdirSync(dir, { recursive: true });
    const beginning = "BEGIN_MARKER\n";
    const head = "A".repeat(70000);          // 70KB，加上开头标记后整体超过 64KB
    const tail = "TAIL_MARKER\n";
    writeFileSync(join(dir, "wire.jsonl"), beginning + head + tail);
    const out = await readTail("kimi", cwd, "s1");
    expect(out).toContain("TAIL_MARKER");
    expect(out).not.toContain("BEGIN_MARKER");
  } finally { restore(); }
});

test("readTail returns empty string for missing files", async () => {
  const { restore } = tmpHome();
  try {
    expect(await readTail("kimi", "/no/such", "s1")).toBe("");
    expect(await readTail("codex", "/no/such", "s1")).toBe("");
  } finally { restore(); }
});

test("codexSessionPath returns the newest rollout jsonl under ~/.codex/sessions", () => {
  const { home, restore } = tmpHome();
  try {
    const base = join(home, ".codex", "sessions", "2026", "07", "31");
    mkdirSync(base, { recursive: true });
    const oldFile = join(base, "rollout-old.jsonl");
    const newFile = join(base, "rollout-new.jsonl");
    writeFileSync(oldFile, "old");
    // 用 100ms 间隔确保 mtime 不同；Bun.sleep 同步写可安全用。
    Bun.sleepSync(50);
    writeFileSync(newFile, "new");
    expect(codexSessionPath("/x", "s1")).toBe(newFile);
  } finally { restore(); }
});

// slug 规则的三条断言分别对应本机 ~/.claude/projects/ 实测到的三个事实。
// 这个测试此前把错误行为固化成了断言（用 `_`、strip 开头、截断 64），
// 于是实现与测试一起错、永远绿灯，而真实环境下 readTail 恒返回空串。
test("claudeSessionPath: 分隔符是 `-`，保留开头分隔符，不截断", () => {
  const { home, restore } = tmpHome();
  try {
    // 实测样本：本机该目录真实存在
    expect(claudeSessionPath("/Volumes/ssd/document/project/phone-term", "s1")).toBe(
      join(home, ".claude", "projects", "-Volumes-ssd-document-project-phone-term", "s1.jsonl"),
    );
    // 开头的分隔符必须保留
    expect(claudeSessionPath("/home/user/project", "s1")).toBe(
      join(home, ".claude", "projects", "-home-user-project", "s1.jsonl"),
    );
    // 不截断：本机存在 73 字符的目录名
    const long = "/Volumes/ssd/document/project/phone-term/.claude/worktrees/notify-feature";
    expect(claudeSessionPath(long, "s1")).toBe(
      join(home, ".claude", "projects", "-Volumes-ssd-document-project-phone-term--claude-worktrees-notify-feature", "s1.jsonl"),
    );
  } finally { restore(); }
});

// 上面所有用例都跑在 mock 的临时 HOME 上——路径规则错了它们照样绿。
// 这条对着真实的 ~/.claude/projects 校验：本机若存在该目录，就断言我们
// 算出的 slug 真能命中一个实际存在的目录。这是唯一能抓住「slug 规则与
// Claude Code 实际命名不符」的测试。
test("claudeSessionPath: 算出的目录在真实 ~/.claude/projects 下确实存在", () => {
  const base = join(homedir(), ".claude", "projects");
  if (!existsSync(base)) return; // 没装 Claude Code 的机器上跳过
  // 用本仓库自己的路径当样本：它是一个我们确知 Claude Code 跑过的 cwd，
  // 所以对应目录必然存在。slug 规则一旦写错（用 `_`、strip 开头、截断），
  // 这里算出的目录就不存在，测试立刻失败——这正是之前漏掉的那一环。
  const repoCwd = "/Volumes/ssd/document/project/phone-term";
  const dir = dirname(claudeSessionPath(repoCwd, "sid"));
  if (!existsSync(join(base, "-Volumes-ssd-document-project-phone-term"))) return; // 换机器就跳过
  expect(existsSync(dir)).toBe(true);
});

test("opencode readTail always returns empty string", async () => {
  const { restore } = tmpHome();
  try {
    expect(await readTail("opencode", "/x", "s1")).toBe("");
  } finally { restore(); }
});

test("codexSessionPath 按 rollout 首行的 cwd 选文件，不串会话", () => {
  const { home, restore } = tmpHome();
  try {
    const base = join(home, ".codex", "sessions", "2026", "07", "31");
    mkdirSync(base, { recursive: true });
    const meta = (cwd: string) => JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n";
    const projA = join(base, "rollout-a.jsonl");
    const projB = join(base, "rollout-b.jsonl");
    writeFileSync(projA, meta("/proj/a"));
    Bun.sleepSync(20);
    writeFileSync(projB, meta("/proj/b"));   // B 更新，全局最新是 B
    // 站在 A 的角度取：必须拿到 A 的文件，而不是 mtime 更新的 B
    expect(codexSessionPath("/proj/a", "s1")).toBe(projA);
    expect(codexSessionPath("/proj/b", "s1")).toBe(projB);
  } finally { restore(); }
});

test("codexSessionPath 在 cwd 匹配不到时回落到最新文件", () => {
  const { home, restore } = tmpHome();
  try {
    const base = join(home, ".codex", "sessions", "2026", "07", "31");
    mkdirSync(base, { recursive: true });
    const older = join(base, "rollout-old.jsonl");
    const newer = join(base, "rollout-new.jsonl");
    writeFileSync(older, JSON.stringify({ type: "session_meta", payload: { cwd: "/other" } }) + "\n");
    Bun.sleepSync(20);
    writeFileSync(newer, JSON.stringify({ type: "session_meta", payload: { cwd: "/other2" } }) + "\n");
    expect(codexSessionPath("/no/match", "s1")).toBe(newer);
  } finally { restore(); }
});

test("codexSessionPath 容忍首行不是合法 JSON 的文件", () => {
  const { home, restore } = tmpHome();
  try {
    const base = join(home, ".codex", "sessions", "2026", "07", "31");
    mkdirSync(base, { recursive: true });
    const broken = join(base, "rollout-broken.jsonl");
    const good = join(base, "rollout-good.jsonl");
    writeFileSync(broken, "not json at all\n");
    Bun.sleepSync(20);
    writeFileSync(good, JSON.stringify({ type: "session_meta", payload: { cwd: "/proj/x" } }) + "\n");
    expect(codexSessionPath("/proj/x", "s1")).toBe(good);
  } finally { restore(); }
});
