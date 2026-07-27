// agent/src/hint-store.ts
// 需求 5：用户自定义的输入联想条目，持久化在 <keyDir>/pocketshell.db（与
// snippets 同一个库文件，各自建表）。text 列上 UNIQUE，配合 INSERT OR IGNORE
// 让重复导入天然幂等——应用层不必对自定义项之间做去重。
// now()/genId() 可注入，保持测试确定性（与 snippet-store 同构）。
import { Database } from "bun:sqlite";

export interface HintRecord { id: string; text: string; createdAt: number }

export interface HintStore {
  list(): HintRecord[];
  /** 批量入库；只返回**真正新增**的记录（已存在的被 IGNORE，不出现在返回值里）。 */
  addMany(texts: string[]): HintRecord[];
  update(id: string, text: string): boolean;
  remove(id: string): boolean;
  clear(): void;
  count(): number;
}

let counter = 0;
function defaultGenId(now: () => number): () => string {
  return () => `${now().toString(36)}-${(counter++).toString(36)}`;
}

export function openHintStore(
  dbPath: string,
  opts: { now?: () => number; genId?: () => string } = {},
): HintStore {
  const now = opts.now ?? (() => Date.now());
  const genId = opts.genId ?? defaultGenId(now);
  const db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS hints (
    id TEXT PRIMARY KEY, text TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
  )`);

  const rowToRec = (r: any): HintRecord => ({ id: r.id, text: r.text, createdAt: r.created_at });

  return {
    list() {
      return db.query("SELECT * FROM hints ORDER BY created_at ASC, id ASC").all().map(rowToRec);
    },
    addMany(texts) {
      const added: HintRecord[] = [];
      for (const text of texts) {
        const rec: HintRecord = { id: genId(), text, createdAt: now() };
        const info = db.run(
          "INSERT OR IGNORE INTO hints (id, text, created_at) VALUES (?, ?, ?)",
          [rec.id, rec.text, rec.createdAt],
        );
        // changes === 0 表示 UNIQUE 冲突被 IGNORE 掉了（库里已有同样文本），
        // 不计入返回值——前端靠「提交条数 − 新增条数」算「库中已有」的跳过数。
        if (info.changes > 0) added.push(rec);
      }
      return added;
    },
    update(id, text) {
      try {
        const info = db.run("UPDATE hints SET text = ? WHERE id = ?", [text, id]);
        return info.changes > 0;
      } catch {
        // UNIQUE 冲突（改成了库里已有的文本）→ 视为失败，不抛给调用方
        return false;
      }
    },
    remove(id) {
      return db.run("DELETE FROM hints WHERE id = ?", [id]).changes > 0;
    },
    clear() {
      db.run("DELETE FROM hints");
    },
    count() {
      const r = db.query("SELECT COUNT(*) AS c FROM hints").get() as { c: number };
      return r.c;
    },
  };
}
