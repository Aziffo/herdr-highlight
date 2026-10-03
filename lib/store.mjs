import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseColor } from './colors.mjs';

function initializeWithRetry(operation) {
  const deadline = performance.now() + 5000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try { return operation(); }
    catch (error) {
      // WAL transitions can return SQLITE_BUSY immediately instead of invoking
      // SQLite's busy handler. Retrying idempotent initialization is safe.
      const remaining = deadline - performance.now();
      if ((error.errcode & 255) !== 5 || remaining <= 0) throw error;
      Atomics.wait(wait, 0, 0, Math.min(20, remaining));
    }
  }
}

export class HighlightStore {
  constructor(stateDir, namespace) {
    mkdirSync(stateDir, { recursive: true });
    this.namespace = namespace;
    this.db = new DatabaseSync(join(stateDir, 'highlights.sqlite'), { timeout: 5000 });
    try {
      const version = this.db.prepare('PRAGMA user_version').all()[0].user_version;
      if (version > 1) throw new Error('Highlight state was written by a newer plugin; refusing to overwrite it');
      if (version === 0) initializeWithRetry(() => {
        this.db.exec('PRAGMA journal_mode = WAL');
        this.transaction(() => {
          const current = this.db.prepare('PRAGMA user_version').all()[0].user_version;
          if (current > 1) throw new Error('Highlight state was written by a newer plugin; refusing to overwrite it');
          if (current === 0) this.db.exec(`
            CREATE TABLE IF NOT EXISTS endpoints (endpoint TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS highlights (
              endpoint TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('workspace', 'tab')),
              resource_id TEXT NOT NULL, workspace_id TEXT NOT NULL, color TEXT NOT NULL
                CHECK(color IN ('red','peach','yellow','green','teal','blue','mauve','gray')),
              PRIMARY KEY(endpoint, kind, resource_id)
            );
            PRAGMA user_version = 1;
          `);
        });
      });
      this.db.prepare('INSERT OR IGNORE INTO endpoints(endpoint) VALUES (?)').run(namespace);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get(kind, id) {
    return this.db.prepare('SELECT color FROM highlights WHERE endpoint=? AND kind=? AND resource_id=?')
      .get(this.namespace, kind, id)?.color ?? null;
  }

  set(target, color) {
    if (color !== null) parseColor(color);
    this.transaction(() => {
      if (color === null) {
        this.db.prepare('DELETE FROM highlights WHERE endpoint=? AND kind=? AND resource_id=?')
          .run(this.namespace, target.kind, target.id);
      } else {
        this.db.prepare(`INSERT INTO highlights VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(endpoint, kind, resource_id) DO UPDATE SET workspace_id=excluded.workspace_id, color=excluded.color`)
          .run(this.namespace, target.kind, target.id, target.workspaceId, color);
      }
    });
  }

  removeClosed(event) {
    if (event?.event === 'workspace_closed') {
      this.db.prepare('DELETE FROM highlights WHERE endpoint=? AND workspace_id=?')
        .run(this.namespace, event.data.workspace_id);
    } else if (event?.event === 'tab_closed') {
      this.db.prepare("DELETE FROM highlights WHERE endpoint=? AND kind='tab' AND resource_id=?")
        .run(this.namespace, event.data.tab_id);
    } else if (event?.event === 'pane_moved') {
      if (event.data.closed_workspace_id) {
        this.db.prepare('DELETE FROM highlights WHERE endpoint=? AND workspace_id=?')
          .run(this.namespace, event.data.closed_workspace_id);
      }
      if (event.data.closed_tab_id) {
        this.db.prepare("DELETE FROM highlights WHERE endpoint=? AND kind='tab' AND resource_id=?")
          .run(this.namespace, event.data.closed_tab_id);
      }
    }
  }

  snapshot() {
    return this.transaction(() => {
      const { revision: seq } = this.db.prepare('UPDATE endpoints SET revision=revision+1 WHERE endpoint=? RETURNING revision')
        .get(this.namespace);
      const rows = this.db.prepare('SELECT kind, resource_id, workspace_id, color FROM highlights WHERE endpoint=? ORDER BY kind, resource_id')
        .all(this.namespace).map(row => ({ ...row }));
      return { seq, rows };
    });
  }

  close() { this.db.close(); }
}
