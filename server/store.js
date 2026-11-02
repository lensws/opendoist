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
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_config (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_outbox (
        key TEXT PRIMARY KEY, channel TEXT NOT NULL, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        event TEXT NOT NULL, scheduled INTEGER NOT NULL, expires INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, sent_at INTEGER, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS notification_pending ON notification_outbox(status,next_attempt);
      PRAGMA user_version=3;`);
  }
  settings() {
    const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get();
    return row ? JSON.parse(row.data) : { theme: 'system', accent: '#c95736', timezone: 'Europe/Moscow', language: 'auto' };
  }
  saveSettings(patch) {
    const allowed = ['theme', 'accent', 'timezone', 'language'];
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw new AppError(400, 'Неизвестная настройка');
    const next = { ...this.settings(), ...patch };
    if (!['light', 'dark', 'system'].includes(next.theme) || !['auto', 'ru', 'en'].includes(next.language) || typeof next.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(next.accent)) throw new AppError(400, 'Некорректные настройки оформления или языка');
    if (typeof next.timezone !== 'string' || !next.timezone.trim() || next.timezone.length > 100) throw new AppError(400, 'Некорректный часовой пояс');
    try { new Intl.DateTimeFormat('ru', { timeZone: next.timezone }); } catch { throw new AppError(400, 'Некорректный часовой пояс'); }
    next.accent = next.accent.toLowerCase();
    this.db.prepare('INSERT INTO settings (id,data) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(next));
    return next;
  }
  notificationConfig() {
    const row = this.db.prepare('SELECT data FROM notification_config WHERE id=1').get();
    return row ? JSON.parse(row.data) : null;
  }
  saveNotificationConfig(config) {
    this.db.prepare('INSERT INTO notification_config (id,data) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(config));
  }
  notificationStatus() {
    return this.db.prepare('SELECT channel,status,attempts,scheduled,sent_at,last_error FROM notification_outbox ORDER BY scheduled DESC LIMIT 20').all();
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
