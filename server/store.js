import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nextAfterCompletion } from '../src/index.js';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS completions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, completed_at TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  list() { return this.db.prepare('SELECT data FROM tasks').all().map(r => JSON.parse(r.data)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) { const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id); if (!row) throw new AppError(404, 'Задача не найдена'); return JSON.parse(row.data); }
  create(parsed) {
    const now = new Date().toISOString();
    const task = { ...parsed, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now, completedAt: null };
    this.db.prepare('INSERT INTO tasks VALUES (?,?,?)').run(task.id, JSON.stringify(task), 1);
    return task;
  }
  mutate(id, revision, change) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.get(id);
      if (task.revision !== revision) throw new AppError(409, 'Задача изменилась в другом окне. Обновите список.');
      const next = change(task);
      if (next === null) this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      else {
        next.revision = task.revision + 1; next.updatedAt = new Date().toISOString();
        this.db.prepare('UPDATE tasks SET data=?,revision=? WHERE id=?').run(JSON.stringify(next), next.revision, id);
      }
      this.db.exec('COMMIT'); return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  complete(id, revision) {
    return this.mutate(id, revision, task => {
      if (task.completedAt) throw new AppError(409, 'Задача уже выполнена');
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO completions VALUES (?,?,?,?)').run(randomUUID(), id, now, JSON.stringify(task));
      const next = task.recurrence ? nextAfterCompletion(task, now) : null;
      return { ...task, due: next ?? task.due, completedAt: next ? null : now };
    });
  }
  undo(id, revision) {
    return this.mutate(id, revision, task => {
      const row = this.db.prepare('SELECT id,snapshot FROM completions WHERE task_id=? ORDER BY completed_at DESC,rowid DESC LIMIT 1').get(id);
      if (!row) throw new AppError(409, 'Нет выполнения для отмены');
      const previous = JSON.parse(row.snapshot);
      // Do not overwrite intervening edits with a stale snapshot.
      if (previous.revision !== task.revision - 1) throw new AppError(409, 'После выполнения задача была изменена');
      this.db.prepare('DELETE FROM completions WHERE id=?').run(row.id);
      return { ...previous, revision: task.revision };
    });
  }
  history() { return this.db.prepare('SELECT completed_at,snapshot FROM completions ORDER BY completed_at DESC LIMIT 100').all().map(r => ({ completedAt: r.completed_at, task: JSON.parse(r.snapshot) })); }
}
