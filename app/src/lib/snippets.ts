// app/src/lib/snippets.ts
// Built-in snippets are a frontend constant (never stored server-side). The
// backend syncs only user-added custom snippets; the panel shows builtins ∪ customs.
import type { Snippet } from "./protocol";

const b = (id: string, group: string, label: string, command: string, autoEnter = true): Snippet =>
  ({ id: `builtin:${id}`, group, label, command, autoEnter });

export const BUILTIN_SNIPPETS: Snippet[] = [
  b("claude", "Claude Code", "claude", "claude"),
  b("claude-cont", "Claude Code", "继续", "claude --continue"),
  b("claude-resume", "Claude Code", "恢复", "claude --resume"),
  b("git-status", "Git", "status", "git status"),
  b("git-add", "Git", "add -A", "git add -A"),
  b("git-commit", "Git", "commit", "git commit", false),
  b("git-push", "Git", "push", "git push"),
  b("git-log", "Git", "log", "git log --oneline -20"),
  b("git-diff", "Git", "diff", "git diff"),
  b("proj-test", "项目", "bun test", "bun test"),
  b("proj-dev", "项目", "dev", "npm run dev"),
  b("proj-ls", "项目", "ls -la", "ls -la"),
];

export interface SnippetGroup { group: string; items: Snippet[] }

export function mergeSnippets(customs: Snippet[]): SnippetGroup[] {
  const order: string[] = [];
  const map = new Map<string, Snippet[]>();
  const push = (s: Snippet) => {
    if (!map.has(s.group)) { map.set(s.group, []); order.push(s.group); }
    map.get(s.group)!.push(s);
  };
  for (const s of BUILTIN_SNIPPETS) push(s);
  for (const s of customs) push(s);
  return order.map((group) => ({ group, items: map.get(group)! }));
}
