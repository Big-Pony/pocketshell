// agent/src/snippet-store.test.ts
import { test, expect } from "bun:test";
import { openSnippetStore } from "./snippet-store";

function freshStore() {
  let t = 1000, n = 0;
  return openSnippetStore(":memory:", { now: () => t++, genId: () => `id${++n}` });
}

test("add returns a record and list reflects it", () => {
  const s = freshStore();
  const rec = s.add({ group: "Git", label: "status", command: "git status", autoEnter: true });
  expect(rec.id).toBe("id1");
  expect(rec.group).toBe("Git");
  expect(rec.autoEnter).toBe(true);
  expect(s.list()).toHaveLength(1);
  expect(s.list()[0].command).toBe("git status");
});

test("list is ordered by createdAt ascending", () => {
  const s = freshStore();
  s.add({ group: "a", label: "1", command: "one", autoEnter: false });
  s.add({ group: "a", label: "2", command: "two", autoEnter: false });
  expect(s.list().map((r) => r.label)).toEqual(["1", "2"]);
});

test("remove deletes by id and reports hit/miss", () => {
  const s = freshStore();
  const r = s.add({ group: "a", label: "1", command: "one", autoEnter: false });
  expect(s.remove(r.id)).toBe(true);
  expect(s.remove(r.id)).toBe(false);
  expect(s.list()).toHaveLength(0);
});

test("update 修改字段但不改 createdAt，列表位置不变", () => {
  const s = freshStore();
  const a = s.add({ group: "g", label: "first", command: "one", autoEnter: false });
  s.add({ group: "g", label: "second", command: "two", autoEnter: false });
  const beforeCreatedAt = s.list()[0].createdAt;

  expect(s.update(a.id, { group: "g2", label: "edited", command: "one-x", autoEnter: true })).toBe(true);

  const list = s.list();
  expect(list.map((r) => r.label)).toEqual(["edited", "second"]); // 仍在第一位
  expect(list[0].id).toBe(a.id);                                   // id 不变
  expect(list[0].createdAt).toBe(beforeCreatedAt);                 // createdAt 不变
  expect(list[0].group).toBe("g2");
  expect(list[0].command).toBe("one-x");
  expect(list[0].autoEnter).toBe(true);
});

test("update 对不存在的 id 返回 false 且不新增记录", () => {
  const s = freshStore();
  s.add({ group: "g", label: "a", command: "a", autoEnter: false });
  expect(s.update("nope", { group: "x", label: "x", command: "x", autoEnter: false })).toBe(false);
  expect(s.list()).toHaveLength(1);
});

test("update 可以把 autoEnter 从 true 改回 false", () => {
  const s = freshStore();
  const r = s.add({ group: "g", label: "a", command: "a", autoEnter: true });
  s.update(r.id, { group: "g", label: "a", command: "a", autoEnter: false });
  expect(s.list()[0].autoEnter).toBe(false);
});

test("persists across reopen of the same file", () => {
  const dir = process.env.POCKETSHELL_KEY_DIR ?? "/tmp";
  const path = `${dir}/snip-test-${process.pid}.db`;
  let n = 0;
  const s1 = openSnippetStore(path, { now: () => 5, genId: () => `p${++n}` });
  s1.add({ group: "g", label: "l", command: "c", autoEnter: true });
  const s2 = openSnippetStore(path, {});
  const list = s2.list();
  expect(list.map((r) => r.command)).toEqual(["c"]);
  // cleanup
  require("node:fs").rmSync(path, { force: true });
  require("node:fs").rmSync(path + "-wal", { force: true });
  require("node:fs").rmSync(path + "-shm", { force: true });
});
