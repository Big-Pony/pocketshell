// agent/src/snippet-store.ts
// S5-store: persistent custom snippets in a bun:sqlite database at <keyDir>/pocketshell.db.
// Built-in snippets are a FRONTEND constant and never stored here. now()/genId()
// are injectable to keep tests deterministic (no Date.now/Math.random in prod path
// beyond the defaults wired at construction).
import { Database } from "bun:sqlite";

export interface SnippetRecord {
  id: string; group: string; label: string; command: string; autoEnter: boolean; createdAt: number;
}

export interface SnippetStore {
  list(): SnippetRecord[];
  add(i: { group: string; label: string; command: string; autoEnter: boolean }): SnippetRecord;
  remove(id: string): boolean;
}

let counter = 0;
function defaultGenId(now: () => number): () => string {
  return () => `${now().toString(36)}-${(counter++).toString(36)}`;
}

export function openSnippetStore(
  dbPath: string,
  opts: { now?: () => number; genId?: () => string } = {},
): SnippetStore {
  const now = opts.now ?? (() => Date.now());
  const genId = opts.genId ?? defaultGenId(now);
  const db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY, grp TEXT NOT NULL, label TEXT NOT NULL,
    command TEXT NOT NULL, auto_enter INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`);

  const rowToRec = (r: any): SnippetRecord => ({
    id: r.id, group: r.grp, label: r.label, command: r.command,
    autoEnter: !!r.auto_enter, createdAt: r.created_at,
  });

  return {
    list() {
      const rows = db.query("SELECT * FROM snippets ORDER BY created_at ASC, id ASC").all();
      return rows.map(rowToRec);
    },
    add(i) {
      const rec: SnippetRecord = {
        id: genId(), group: i.group, label: i.label, command: i.command,
        autoEnter: i.autoEnter, createdAt: now(),
      };
      db.run("INSERT INTO snippets (id, grp, label, command, auto_enter, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [rec.id, rec.group, rec.label, rec.command, rec.autoEnter ? 1 : 0, rec.createdAt]);
      return rec;
    },
    remove(id) {
      const info = db.run("DELETE FROM snippets WHERE id = ?", [id]);
      return info.changes > 0;
    },
  };
}
