import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { entityFields, projectView } from './projects.js';
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
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sections (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_cursors (bot TEXT PRIMARY KEY, offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_replies (bot TEXT NOT NULL, update_id INTEGER NOT NULL, chat_id TEXT NOT NULL, text TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, PRIMARY KEY(bot,update_id));
      PRAGMA user_version=4;`);
  }
  projects() { return this.db.prepare('SELECT data FROM projects ORDER BY rowid').all().map((r, index) => ({ ...JSON.parse(r.data), position: JSON.parse(r.data).position ?? index })).sort((a,b) => a.position-b.position); }
  reorderProjects(ids, previousIds) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const projects = this.projects(), current = projects.map(p => p.id);
      if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !current.includes(id))) throw new AppError(400, 'Передайте все проекты без повторений');
      if (JSON.stringify(previousIds) !== JSON.stringify(current)) throw new AppError(409, 'Порядок изменён в другом окне. Обновите список.');
      const update = this.db.prepare('UPDATE projects SET data=? WHERE id=?');
      ids.forEach((id, position) => update.run(JSON.stringify({ ...projects.find(p => p.id === id), position }), id));
      this.db.exec('COMMIT'); return this.projects();
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  sections() { return this.db.prepare('SELECT data FROM sections ORDER BY rowid').all().map(r => JSON.parse(r.data)); }
  placement(projectId = null, sectionId = null) {
    if (projectId !== null && !this.projects().some(p => p.id === projectId)) throw new AppError(400, 'Проект не найден');
    if (sectionId !== null && !this.sections().some(s => s.id === sectionId && s.projectId === projectId)) throw new AppError(400, 'Раздел не принадлежит проекту');
    return { projectId, sectionId };
  }
  saveEntity(kind, body, id = null) {
    const table = kind === 'project' ? 'projects' : 'sections';
    const previous = id ? this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) : null;
    if (id && !previous) throw new AppError(404, 'Не найдено');
    const old = previous && JSON.parse(previous.data);
    if (old && body.revision !== old.revision) throw new AppError(409, 'Изменено в другом окне. Обновите список.');
    const fields = entityFields(body), list = kind === 'project' ? this.projects() : this.sections();
    const projectId = old?.projectId || body.projectId;
    if (kind === 'section') this.placement(projectId, null);
    if (kind === 'section' && !projectId) throw new AppError(400, 'Выберите проект');
    if (list.some(e => e.id !== id && (kind === 'project' || e.projectId === projectId) && e.name.toLocaleLowerCase() === fields.name.toLocaleLowerCase())) throw new AppError(409, 'Такое название уже существует');
    const entity = { id: id || randomUUID(), ...fields, revision: (old?.revision || 0) + 1, ...(kind === 'section' ? { projectId } : { view: projectView(old?.view), position: old?.position ?? (id ? list.find(p => p.id === id).position : Math.max(-1, ...list.map(p => p.position)) + 1) }) };
    if (kind === 'project') this.db.prepare('INSERT INTO projects (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(entity.id, JSON.stringify(entity));
    else this.db.prepare('INSERT INTO sections (id,project_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(entity.id, projectId, JSON.stringify(entity));
    return entity;
  }
  saveProjectView(id, body) {
    const project = this.projects().find(p => p.id === id);
    if (!project) throw new AppError(404, 'Проект не найден');
    if (project.revision !== body.revision) throw new AppError(409, 'Проект изменён в другом окне. Обновите список.');
    const next = { ...project, view: projectView(body.view), revision: project.revision + 1 };
    this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(next), id);
    return next;
  }
  deleteEntity(kind, id, revision) {
    const table = kind === 'project' ? 'projects' : 'sections';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
      if (!row) throw new AppError(404, 'Не найдено');
      if (JSON.parse(row.data).revision !== revision) throw new AppError(409, 'Изменено в другом окне. Обновите список.');
      for (const task of this.list()) if (kind === 'project' ? task.projectId === id : task.sectionId === id) {
        if (kind === 'project') task.projectId = null;
        task.sectionId = null; task.revision++; task.updatedAt = new Date().toISOString();
        this.db.prepare('UPDATE tasks SET data=?,revision=? WHERE id=?').run(JSON.stringify(task), task.revision, task.id);
      }
      this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
  importTasks(document, preview = false) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exists = this.db.prepare('SELECT 1 FROM tasks WHERE id=?');
      const fresh = document.tasks.filter(task => !exists.get(task.id));
      const ids = new Set(fresh.map(task => task.id));
      const history = document.history.filter(item => ids.has(item.task.id));
      const result = { added: fresh.length, skipped: document.tasks.length - fresh.length, history: history.length };
      const newProjects = document.projects.filter(p => !this.projects().some(e => e.id === p.id));
      const newSections = document.sections.filter(s => !this.sections().some(e => e.id === s.id));
      if (newProjects.length || newSections.length) { result.projects = newProjects.length; result.sections = newSections.length; }
      // Reject section identity collisions rather than silently moving imported tasks.
      for (const s of document.sections) if (this.sections().some(e => e.id === s.id && e.projectId !== s.projectId)) throw new AppError(400, 'Раздел из файла уже принадлежит другому проекту');
      if (!preview) {
        const nextPosition = Math.max(-1, ...this.projects().map(p => p.position)) + 1;
        newProjects.forEach((p, index) => this.db.prepare('INSERT INTO projects (id,data) VALUES (?,?)').run(p.id, JSON.stringify({ ...p, position: nextPosition + index })));
        for (const s of newSections) this.db.prepare('INSERT INTO sections (id,project_id,data) VALUES (?,?,?)').run(s.id, s.projectId, JSON.stringify(s));
        const reminderIds = new Map(), importedAt = Date.now();
        const prepare = task => ({ ...task, reminders: task.reminders.map(r => {
          const key = `${task.id}:${r.id}`;
          if (!reminderIds.has(key)) reminderIds.set(key, randomUUID());
          return { ...r, id: reminderIds.get(key), createdAt: Math.max(r.createdAt, importedAt) };
        }) });
        const insert = this.db.prepare('INSERT INTO tasks (id,data,revision) VALUES (?,?,?)');
        for (const task of fresh) insert.run(task.id, JSON.stringify(prepare(task)), task.revision);
        const insertHistory = this.db.prepare('INSERT INTO completions (id,task_id,completed_at,snapshot) VALUES (?,?,?,?)');
        for (const item of history) insertHistory.run(randomUUID(), item.task.id, item.completedAt, JSON.stringify(prepare(item.task)));
      }
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
