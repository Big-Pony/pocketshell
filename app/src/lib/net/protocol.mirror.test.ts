// app/src/lib/protocol.mirror.test.ts
// 线协议镜像防漂移。app/src/lib/protocol.ts 是 agent/src/protocol.ts 的逐字副本
// （文件头就写着 "Keep field names byte-for-byte identical"），规矩是「改协议先改
// 后端」。但这条规矩此前只靠自觉——两边都是纯类型声明，**编译期不会有任何交叉
// 校验**：后端加一个字段、前端漏抄，tsc 两边各自都过，跑起来才发现字段静默丢失。
//
// 这里不做全文 diff（两边注释本就不同、函数顺序也不同），而是把两个文件解析成
// **语义结构**再比：联合类型的成员签名、接口的字段名+可选性+类型、导出符号集合。
// 注释、空白、成员顺序的差异一律不算漂移，字段/类型的差异一个都跑不掉。
//
// 放在 app 侧而不是 agent 侧的理由：app 是「副本」的一方（漂移就是这边漏抄），
// 且 app 已有读取源文件做静态校验的先例（src/app.css.test.ts）。两边以纯文本读入
// （不 import），所以不牵扯跨子项目的模块解析与 tsconfig。
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const AGENT_SRC = resolve(__dirname, "../../../../agent/src/protocol.ts");
const APP_SRC = resolve(__dirname, "./protocol.ts");

/** 去掉行/块注释，但不碰字符串字面量里的 `//`。 */
function stripComments(src: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
      if (c === quote) quote = "";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

const OPEN = "{([<";
const CLOSE = "})]>";

/** 按分隔符切分，但只在括号深度 0 处下刀。 */
function splitTop(s: string, seps: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    if (seps.includes(c) && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** `export type X = …;` 的右值（分号只在深度 0 处才算结束）。 */
function typeAlias(src: string, name: string): string {
  const head = new RegExp(`export\\s+type\\s+${name}\\s*=`).exec(src);
  if (!head) throw new Error(`未找到 type ${name}`);
  let depth = 0;
  let i = head.index + head[0].length;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === ";" && depth === 0) break;
  }
  return src.slice(start, i).trim();
}

/** `export interface X { … }` 的花括号内容（大括号配对，不贪婪匹配）。 */
function interfaceBody(src: string, name: string): string {
  const head = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`).exec(src);
  if (!head) throw new Error(`未找到 interface ${name}`);
  let depth = 1;
  let i = head.index + head[0].length;
  const start = i;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

/**
 * 把对象字面量类型展平成有序的 `name?: type` 列表；嵌套对象递归成 `error.code: string`。
 * 排序后返回——字段顺序不是语义，字段名/可选性/类型才是。
 */
function objectFields(body: string, prefix = ""): string[] {
  const inner = body.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: string[] = [];
  for (const part of splitTop(inner, ";,")) {
    const m = /^([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/.exec(part);
    if (!m) continue;
    const [, key, opt, rawType] = m;
    const type = rawType.trim();
    const label = `${prefix}${key}${opt ?? ""}`;
    if (type.startsWith("{") && type.endsWith("}")) out.push(...objectFields(type, `${label}.`));
    else out.push(`${label}: ${type.replace(/\s+/g, " ")}`);
  }
  return out.sort();
}

/** 联合类型的成员，每个成员规范化成 `a: X | b?: Y` 的稳定签名。 */
function unionSignatures(src: string, name: string): string[] {
  return splitTop(typeAlias(src, name), "|").map((m) => objectFields(m).join(" | ")).sort();
}

/** 联合成员的 `type` 字面量（ServerMsg 的 response 出现两次，故按多重集处理）。 */
function unionTags(src: string, name: string): string[] {
  return splitTop(typeAlias(src, name), "|")
    .map((m) => /(?:^|[{;])\s*type\s*:\s*("[^"]+")/.exec(m)?.[1] ?? `<无 type 字面量: ${m}>`)
    .sort();
}

function exportedNames(src: string): string[] {
  return [...src.matchAll(/export\s+(?:type|interface|function|const)\s+([A-Za-z_$][\w$]*)/g)]
    .map((m) => m[1])
    .sort();
}

const AGENT = stripComments(readFileSync(AGENT_SRC, "utf8"));
const APP = stripComments(readFileSync(APP_SRC, "utf8"));

test("两侧导出的符号集合完全一致", () => {
  // 一侧新增/删除类型或函数，另一侧漏跟——最外层的漏网。
  expect(exportedNames(APP), "app/src/lib/protocol.ts 与 agent/src/protocol.ts 的导出集合不一致").toEqual(exportedNames(AGENT));
});

test("SessionState 的取值集合一致", () => {
  expect(splitTop(typeAlias(APP, "SessionState"), "|").sort())
    .toEqual(splitTop(typeAlias(AGENT, "SessionState"), "|").sort());
});

for (const union of ["ClientMsg", "ServerMsg"] as const) {
  test(`${union} 的 type 字面量集合一致`, () => {
    expect(unionTags(APP, union), `${union} 少了/多了一种消息类型`).toEqual(unionTags(AGENT, union));
  });

  test(`${union} 每个成员的字段（名/可选性/类型）一致`, () => {
    // 这条才是「字段悄悄丢失」的正面拦截：type 对得上但载荷少一个字段的情况。
    expect(unionSignatures(APP, union), `${union} 有成员的字段与后端对不上`).toEqual(unionSignatures(AGENT, union));
  });
}

test("每个导出的 interface 字段一致", () => {
  // 遍历实际存在的 interface，而不是写死名单——新增接口自动纳入比对。
  const names = [...AGENT.matchAll(/export\s+interface\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  expect(names.length, "没解析到任何 interface，解析器可能失效了").toBeGreaterThan(3);
  for (const name of names) {
    expect(objectFields(interfaceBody(APP, name)), `interface ${name} 与后端漂移`)
      .toEqual(objectFields(interfaceBody(AGENT, name)));
  }
});

test("解析器自身有效性自检", () => {
  // 上面所有断言都是「两边相等」，解析器一旦静默返回空数组，全部会假阳性通过。
  // 这里对已知内容做一次锚定，保证解析器真的抓到了东西。
  expect(unionTags(AGENT, "ClientMsg")).toContain('"attach"');
  expect(unionTags(AGENT, "ServerMsg").filter((t) => t === '"response"')).toHaveLength(2);
  expect(objectFields(interfaceBody(AGENT, "SessionMeta"))).toContain("ctxUsed?: number");
  expect(objectFields(interfaceBody(AGENT, "SessionMeta"))).toContain("name: string");
  expect(unionSignatures(AGENT, "ServerMsg").some((s) => s.includes("error.code: string"))).toBe(true);
});
