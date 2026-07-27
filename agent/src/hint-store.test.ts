// agent/src/hint-store.test.ts
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHintStore } from "./hint-store";

function freshStore() {
  let t = 1000, n = 0;
  return openHintStore(":memory:", { now: () => t++, genId: () => `h${++n}` });
}

test("addMany 入库并按 createdAt 升序返回", () => {
  const s = freshStore();
  s.addMany(["git status", "npm test"]);
  expect(s.list().map((r) => r.text)).toEqual(["git status", "npm test"]);
});

test("addMany 只返回真正新增的记录（重复项被 IGNORE 且不计入）", () => {
  const s = freshStore();
  s.addMany(["a", "b"]);
  const added = s.addMany(["b", "c"]);
  expect(added.map((r) => r.text)).toEqual(["c"]);   // b 已存在，不返回
  expect(s.count()).toBe(3);
});

test("addMany 同一批内的重复只入库一条", () => {
  const s = freshStore();
  const added = s.addMany(["x", "x", "y"]);
  expect(added.map((r) => r.text)).toEqual(["x", "y"]);
  expect(s.count()).toBe(2);
});

test("addMany 空数组是 no-op", () => {
  const s = freshStore();
  expect(s.addMany([])).toEqual([]);
  expect(s.count()).toBe(0);
});

test("update 改文本并保持 id 与 createdAt", () => {
  const s = freshStore();
  const [a] = s.addMany(["old"]);
  const before = s.list()[0].createdAt;
  expect(s.update(a.id, "new")).toBe(true);
  expect(s.list()[0].text).toBe("new");
  expect(s.list()[0].id).toBe(a.id);
  expect(s.list()[0].createdAt).toBe(before);
});

test("update 对不存在的 id 返回 false", () => {
  const s = freshStore();
  expect(s.update("nope", "x")).toBe(false);
});

test("update 改成已存在的文本时返回 false 且不破坏数据", () => {
  const s = freshStore();
  const [a] = s.addMany(["a", "b"]);
  // UNIQUE 冲突：吞掉异常返回 false，库里仍是两条原样
  expect(s.update(a.id, "b")).toBe(false);
  expect(s.list().map((r) => r.text)).toEqual(["a", "b"]);
});

test("remove 按 id 删除并报告命中", () => {
  const s = freshStore();
  const [a] = s.addMany(["a"]);
  expect(s.remove(a.id)).toBe(true);
  expect(s.remove(a.id)).toBe(false);
  expect(s.count()).toBe(0);
});

test("clear 清空全部", () => {
  const s = freshStore();
  s.addMany(["a", "b", "c"]);
  s.clear();
  expect(s.count()).toBe(0);
  expect(s.list()).toEqual([]);
});

test("持久化到文件后重开仍在", () => {
  // 固定用 tmpdir 而非 POCKETSHELL_KEY_DIR：跑测试时后者常指向真实 keyDir，
  // 会把 .db 残留物写进生产目录。用完即删，不留垃圾。
  const path = join(tmpdir(), `hint-test-${process.pid}.db`);
  try {
    let n = 0;
    const s1 = openHintStore(path, { now: () => 5, genId: () => `p${++n}` });
    s1.addMany(["persisted"]);
    const s2 = openHintStore(path, { now: () => 9, genId: () => `q${++n}` });
    expect(s2.list().map((r) => r.text)).toEqual(["persisted"]);
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  }
});
