// 假 git 数据。结构逐字对齐 agent/src/git-service.ts —— Git 面板是照那个
// 形状写的，字段名对不上就渲染不出来。
import { tr } from "../lib/i18n";

export const GIT_BRANCHES = {
  current: "main",
  branches: ["main", "feat/session-guard", "fix/mac-compare"],
};

export const GIT_STATUS = {
  files: [
    { path: "src/auth.ts", status: "M" as const },
    { path: "tests/auth.test.ts", status: "A" as const },
    { path: "notes.txt", status: "?" as const },
  ],
};

export const GIT_LOG = {
  commits: [
    {
      hash: "9f3c1ab", msg: "fix: reject sessions with a missing claims object",
      author: "demo", when: "2 hours ago",
      files: [{ path: "src/auth.ts", add: 1, del: 0 }],
    },
    {
      hash: "4d81e07", msg: "test: cover the expired-token path",
      author: "demo", when: "3 hours ago",
      files: [{ path: "tests/auth.test.ts", add: 7, del: 0 }],
    },
    {
      hash: "c02fa55", msg: "feat: HMAC-signed session tokens",
      author: "demo", when: "yesterday",
      files: [
        { path: "src/crypto.ts", add: 21, del: 0 },
        { path: "src/auth.ts", add: 18, del: 4 },
      ],
    },
  ],
};

export const DIFF_HUNKS = {
  hunks: [
    {
      header: "@@ -6,6 +6,7 @@ export function checkSession(token: string)",
      lines: [
        { kind: "ctx" as const, text: "export function checkSession(token: string): Session | null {" },
        { kind: "ctx" as const, text: "  const claims = verify(token);" },
        { kind: "add" as const, text: "  if (!claims) return null;" },
        { kind: "ctx" as const, text: "  if (claims.expiresAt < Date.now()) return null;" },
        { kind: "del" as const, text: "  return { userId: claims.sub };" },
        { kind: "add" as const, text: "  return { userId: claims.sub, expiresAt: claims.expiresAt };" },
        { kind: "ctx" as const, text: "}" },
      ],
    },
  ],
};

export const DEMO_HINTS = {
  items: [
    { id: "h1", text: "claude" },
    { id: "h2", text: "git status" },
    { id: "h3", text: "git diff" },
    { id: "h4", text: "npm test" },
    { id: "h5", text: "cd src" },
    { id: "h6", text: "cat README.md" },
  ],
};

/**
 * Snippet 列表。**是函数不是常量**：模块级常量在 i18n init 之前求值，
 * 标签会被永久冻结成原始 key（同 fs.ts 的 README，见设计 §3）。
 */
export function demoSnippets() {
  return [
    { id: "s1", group: tr("demo.snippets.groupAi"),   label: tr("demo.snippets.assign"),    command: "claude ",     autoEnter: false },
    { id: "s2", group: tr("demo.snippets.groupAi"),   label: tr("demo.snippets.continue"),  command: "continue\r",  autoEnter: true },
    { id: "s3", group: tr("demo.snippets.groupGit"),  label: tr("demo.snippets.gitStatus"), command: "git status\r", autoEnter: true },
    { id: "s4", group: tr("demo.snippets.groupGit"),  label: tr("demo.snippets.gitDiff"),   command: "git diff\r",  autoEnter: true },
    { id: "s5", group: tr("demo.snippets.groupTest"), label: tr("demo.snippets.runTests"),  command: "npm test\r",  autoEnter: true },
  ];
}
