import { describe, it, expect } from "vitest";
import { shouldFold, reviewCacheKey, bodyState, FOLD_THRESHOLD } from "./git-review";
import type { ReviewFile } from "../net/protocol";

const file = (o: Partial<ReviewFile> = {}): ReviewFile =>
  ({ path: "a.ts", status: "M", add: 10, del: 5, ...o });

describe("shouldFold", () => {
  it("小改动默认展开", () => {
    expect(shouldFold(file({ add: 10, del: 5 }))).toBe(false);
  });

  it("超过阈值默认折叠", () => {
    expect(shouldFold(file({ add: 50, del: 20 }))).toBe(true);
  });

  it("恰好等于阈值不折叠（边界取闭区间）", () => {
    expect(shouldFold(file({ add: FOLD_THRESHOLD, del: 0 }))).toBe(false);
    expect(shouldFold(file({ add: FOLD_THRESHOLD + 1, del: 0 }))).toBe(true);
  });

  it("oversize / binary / 删除 / 新目录一律折叠（本就没正文可展开）", () => {
    expect(shouldFold(file({ add: 1, del: 0, oversize: true }))).toBe(true);
    expect(shouldFold(file({ add: 0, del: 0, binary: true }))).toBe(true);
    expect(shouldFold(file({ status: "D" }))).toBe(true);
    expect(shouldFold(file({ status: "?", isDir: true }))).toBe(true);
  });

  it("阈值取 spec 规定值", () => {
    expect(FOLD_THRESHOLD).toBe(60);
  });
});

describe("reviewCacheKey", () => {
  it("三档互不串", () => {
    const k = (stage: "all" | "staged" | "unstaged") =>
      reviewCacheKey({ kind: "worktree", stage });
    expect(new Set([k("all"), k("staged"), k("unstaged")]).size).toBe(3);
  });

  it("不同 commit 不同 key", () => {
    expect(reviewCacheKey({ kind: "commit", hash: "a1" }))
      .not.toBe(reviewCacheKey({ kind: "commit", hash: "b2" }));
  });

  it("不同基线不同 key（切基线必须重拉）", () => {
    expect(reviewCacheKey({ kind: "range", base: "main" }))
      .not.toBe(reviewCacheKey({ kind: "range", base: "develop" }));
  });

  // base 可缺省（后端自行推断）。缺省态必须和任何具名基线都不同 key，
  // 否则「让后端推」和「显式指定 main」会互相顶掉缓存。
  it("缺省 base 与具名 base 不同 key", () => {
    expect(reviewCacheKey({ kind: "range" }))
      .not.toBe(reviewCacheKey({ kind: "range", base: "main" }));
  });

  it("同一 scope 稳定复现", () => {
    const s = { kind: "worktree", stage: "all" } as const;
    expect(reviewCacheKey(s)).toBe(reviewCacheKey({ ...s }));
  });
});

describe("bodyState", () => {
  it("按优先级分派渲染分支", () => {
    expect(bodyState(file({ oversize: true }))).toBe("oversize");
    expect(bodyState(file({ binary: true }))).toBe("binary");
    expect(bodyState(file({ status: "D" }))).toBe("deleted");
    expect(bodyState(file({ status: "?", isDir: true }))).toBe("newdir");
    expect(bodyState(file({ hunks: [{ header: "@@", lines: [] }] }))).toBe("hunks");
    expect(bodyState(file())).toBe("empty");
  });

  it("oversize 优先于 binary（服务端两者都标时先说体量）", () => {
    expect(bodyState(file({ oversize: true, binary: true }))).toBe("oversize");
  });
});
