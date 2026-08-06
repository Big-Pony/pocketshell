// 演示用的假文件系统：一棵字面量树 + 路径解析。只读，内存态，刷新即还原。
//
// 结构对齐 agent/src/fs-service.ts 的 TreeResult/ReadResult —— 前端 FilePanel
// 与 FilePreview 是照那个形状写的，对不上就渲染不出来。
import { tr } from "../lib/i18n";

export const DEMO_ROOT = "/home/demo/project";

export interface DemoNode {
  type: "dir" | "file";
  git?: "M" | "A" | "D" | "?";
  /**
   * 字面量，或惰性求值函数。
   *
   * **走 i18n 的内容必须用函数形式**：模块级常量在 import 期求值，而
   * demo-main.ts 的 setupI18n() 在所有 import 之后才跑——直接写
   * `tr(...)` 会拿到原始 key 并永久冻结，之后切语言也不会变。
   */
  content?: string | (() => string);
  children?: Record<string, DemoNode>;
}

const AUTH_TS = `import { verify } from "./crypto";

export interface Session {
  userId: string;
  expiresAt: number;
}

// Session check: reject when expired, reject when the signature does not match.
export function checkSession(token: string): Session | null {
  const claims = verify(token);
  if (!claims) return null;
  if (claims.expiresAt < Date.now()) return null;
  return { userId: claims.sub, expiresAt: claims.expiresAt };
}
`;

const CRYPTO_TS = `import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.APP_SECRET ?? "dev-only";

export function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export function verify(token: string): { sub: string; expiresAt: number } | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return JSON.parse(Buffer.from(body, "base64url").toString());
}
`;

const PKG_JSON = `{
  "name": "demo-project",
  "version": "0.3.1",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p ."
  }
}
`;

const REPORT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Build report</title>
<style>body{font:14px system-ui;padding:24px}h1{margin:0 0 12px}</style></head>
<body><h1>Build report</h1><p>42 modules · 1.2s · no warnings.</p></body></html>
`;

const AUTH_TEST = `import { test, expect } from "vitest";
import { checkSession } from "../src/auth";

test("rejects an expired token", () => {
  expect(checkSession("expired.sig")).toBeNull();
});
`;

export const TREE: DemoNode = {
  type: "dir",
  children: {
    "README.md": { type: "file", content: () => tr("demo.files.readme") },
    "package.json": { type: "file", content: PKG_JSON },
    src: {
      type: "dir",
      children: {
        "auth.ts": { type: "file", git: "M", content: AUTH_TS },
        "crypto.ts": { type: "file", content: CRYPTO_TS },
      },
    },
    tests: {
      type: "dir",
      children: { "auth.test.ts": { type: "file", git: "A", content: AUTH_TEST } },
    },
    docs: {
      type: "dir",
      children: {
        // 图片走 /preview/demo/ 静态路由，content 用不上（FilePreview 走 <img>）
        "logo.png": { type: "file" },
        "report.html": { type: "file", content: REPORT_HTML },
      },
    },
  },
};

/** 解析 cwd + 参数 → 绝对路径。处理 . / .. / 绝对路径 / 空参数。 */
export function resolvePath(cwd: string, arg: string): string {
  const base = arg.startsWith("/") ? "" : cwd;
  const parts: string[] = [];
  for (const seg of `${base}/${arg}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; } // 越过根就停在根，不产出 /..
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

export function lookup(abs: string): DemoNode | null {
  let node: DemoNode = TREE;
  const segs = resolvePath("/", abs).split("/").filter(Boolean);
  // 树的根挂在 DEMO_ROOT 上，先把前缀吃掉
  const rootSegs = DEMO_ROOT.split("/").filter(Boolean);
  for (let i = 0; i < rootSegs.length; i++) {
    if (segs[i] !== rootSegs[i]) return null;
  }
  for (const seg of segs.slice(rootSegs.length)) {
    const next = node.children?.[seg];
    if (!next) return null;
    node = next;
  }
  return node;
}

export function listDir(abs: string): { name: string; node: DemoNode }[] | null {
  const node = lookup(abs);
  if (!node || node.type !== "dir") return null;
  return Object.entries(node.children ?? {})
    .map(([name, n]) => ({ name, node: n }))
    // 目录在前、同类按名排——与真实文件面板观感一致
    .sort((a, b) => (a.node.type === b.node.type ? a.name.localeCompare(b.name) : a.node.type === "dir" ? -1 : 1));
}

export function treeAt(abs: string): { path: string; nodes: { name: string; type: "dir" | "file"; git?: string; hasChildren?: boolean }[] } | null {
  const entries = listDir(abs);
  if (!entries) return null;
  return {
    path: abs,
    nodes: entries.map(({ name, node }) => ({
      name,
      type: node.type,
      ...(node.git ? { git: node.git } : {}),
      ...(node.type === "dir" ? { hasChildren: Object.keys(node.children ?? {}).length > 0 } : {}),
    })),
  };
}

const LANGS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  md: "markdown", json: "json", html: "xml", css: "css", sh: "bash", py: "python",
};

export function langOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0) return "plaintext";
  return LANGS[name.slice(i + 1).toLowerCase()] ?? "plaintext";
}

// 固定 mtime：与 DEMO_SESSIONS 的 createdAt 同理，别让演示每次刷新都变。
const MTIME = 1_785_920_400_000;

export function readFile(abs: string): { content: string; lang: string; mtime: number } | null {
  const node = lookup(abs);
  if (!node || node.type !== "file") return null;
  const name = abs.slice(abs.lastIndexOf("/") + 1);
  const raw = node.content;
  return {
    content: typeof raw === "function" ? raw() : raw ?? "",
    lang: langOf(name),
    mtime: MTIME,
  };
}
