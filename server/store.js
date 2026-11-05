import { compareTasks, descendants } from '../public/task-tree.js';
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
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, name TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attachments_task ON attachments(task_id);
      CREATE TABLE IF NOT EXISTS backup_config (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version=6;`);
  }
  notes(full = false) {
    return full ? this.db.prepare('SELECT data FROM notes ORDER BY rowid DESC').all().map(r => JSON.parse(r.data))
      : this.db.prepare("SELECT id, json_extract(data,'$.title') AS title, json_extract(data,'$.revision') AS revision FROM notes ORDER BY rowid DESC").all();
  }
  note(id) {
    const row=this.db.prepare('SELECT data FROM notes WHERE id=?').get(id);
    if (!row) throw new AppError(404,'Заметка не найдена');
    return JSON.parse(row.data);
  }
  saveNote(body, id = null) {
    if (typeof body.title !== 'string' || !body.title.trim() || typeof body.body !== 'string') throw new AppError(400,'Укажите заголовок и текст заметки');
    const old=id ? this.note(id) : null;
    if (old && body.revision !== old.revision) throw new AppError(409,'Заметка изменена в другом окне. Ваш текст сохранён в редакторе; скопируйте его перед повторным открытием.');
    const note={id:id || randomUUID(), title:body.title.trim(), body:body.body, revision:(old?.revision || 0)+1};
    this.db.prepare('INSERT INTO notes(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(note.id,JSON.stringify(note));
    return note;
  }
  deleteNote(id, revision) {
    if (this.note(id).revision !== revision) throw new AppError(409,'Заметка изменена в другом окне. Откройте её заново.');
    this.db.prepare('DELETE FROM notes WHERE id=?').run(id);
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
    return row ? { startPage:'inbox', darkPalette:'forest', submitShortcut: 'enter', ...JSON.parse(row.data) } : { startPage:'inbox', darkPalette:'forest', submitShortcut: 'enter', theme: 'system', accent: '#c95736', timezone: 'Europe/Moscow', language: 'auto' };
  }
  saveSettings(patch) {
    const allowed = ['startPage', 'theme', 'darkPalette', 'accent', 'timezone', 'language', 'submitShortcut', 'views'];
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw new AppError(400, 'Неизвестная настройка');
    const next = { ...this.settings(), ...patch };
    if (!['inbox','today','upcoming'].includes(next.startPage)) throw new AppError(400,'Неизвестная стартовая страница');
    if (!['forest','graphite','midnight'].includes(next.darkPalette)) throw new AppError(400,'Неизвестная тёмная палитра');
    if (!['light', 'dark', 'system'].includes(next.theme) || !['auto', 'ru', 'en'].includes(next.language) || typeof next.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(next.accent)) throw new AppError(400, 'Некорректные настройки оформления или языка');
    if (typeof next.timezone !== 'string' || !next.timezone.trim() || next.timezone.length > 100) throw new AppError(400, 'Некорректный часовой пояс');
    try { new Intl.DateTimeFormat('ru', { timeZone: next.timezone }); } catch { throw new AppError(400, 'Некорректный часовой пояс'); }
    if (!['enter', 'ctrl-enter'].includes(next.submitShortcut)) throw new AppError(400, 'Выберите Enter или Ctrl+Enter');
    if (patch.views !== undefined) {
      if (!patch.views || typeof patch.views !== 'object' || Array.isArray(patch.views)) throw new AppError(400, 'Некорректные виды разделов');
      for (const [key, value] of Object.entries(patch.views)) {
        if (!['inbox', 'today', 'upcoming'].includes(key) || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['layout', 'calendar'].includes(k)) || !['list', 'board', 'calendar'].includes(value.layout) || !['month', 'week', 'three-days', 'day'].includes(value.calendar) || (key === 'today' && value.calendar !== 'day')) throw new AppError(400, 'Некорректный вид раздела');
      }
      next.views = { ...this.settings().views, ...patch.views };
    }
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
      const noteExists=this.db.prepare('SELECT 1 FROM notes WHERE id=?');
      const newNotes=(document.notes || []).filter(n=>!noteExists.get(n.id));
      const result = { added: fresh.length, skipped: document.tasks.length - fresh.length, history: history.length };
      if (document.notes?.length) { result.notes=newNotes.length; result.notesSkipped=document.notes.length-newNotes.length; }
      const newProjects = document.projects.filter(p => !this.projects().some(e => e.id === p.id));
      const newSections = document.sections.filter(s => !this.sections().some(e => e.id === s.id));
      if (newProjects.length || newSections.length) { result.projects = newProjects.length; result.sections = newSections.length; }
      // Reject section identity collisions rather than silently moving imported tasks.
      for (const s of document.sections) if (this.sections().some(e => e.id === s.id && e.projectId !== s.projectId)) throw new AppError(400, 'Раздел из файла уже принадлежит другому проекту');
      const combined = new Map([...this.list(), ...fresh].map(t => [t.id, t]));
      for (const task of fresh) {
        const seen = new Set([task.id]); let parentId = task.parentId;
        while (parentId) {
          const parent = combined.get(parentId);
          if (seen.has(parentId) || seen.size > 10 || !parent || (parent.projectId ?? null) !== (task.projectId ?? null) || (parent.sectionId ?? null) !== (task.sectionId ?? null)) throw new AppError(400, 'Вложенность импортированных задач несовместима с существующими задачами');
          seen.add(parentId); parentId = parent.parentId;
        }
      }
      if (!preview) {
        for (const note of newNotes) this.db.prepare('INSERT INTO notes(id,data) VALUES (?,?)').run(note.id,JSON.stringify(note));
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
  backupConfig() { const row = this.db.prepare('SELECT data FROM backup_config WHERE id=1').get(); return row ? JSON.parse(row.data) : null; }
  saveBackupConfig(config) { this.db.prepare('INSERT INTO backup_config VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(config)); }
  attachments(id) { this.get(id); return this.db.prepare('SELECT id,name,length(data) AS size,created_at AS createdAt FROM attachments WHERE task_id=? ORDER BY created_at').all(id); }
  addAttachment(id, name, data) {
    this.get(id);
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f/\\]/.test(name)) throw new AppError(400, 'Некорректное имя файла');
    if (data.length > 20 * 1024 * 1024) throw new AppError(413, 'Файл больше 20 МБ');
    if (this.attachments(id).length >= 20) throw new AppError(400, 'Не более 20 файлов на задачу');
    const fileId = randomUUID();
    this.db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?)').run(fileId, id, name, data, new Date().toISOString());
    return this.attachments(id).find(f => f.id === fileId);
  }
  moveTask(id, body) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const all = this.list(), task = this.get(id), subtree = descendants(all, id);
      const scope = all.filter(t => (t.projectId ?? null) === (task.projectId ?? null));
      const snapshot = items => JSON.stringify(items.map(t => [t.id, t.revision]).sort((a,b) => a[0].localeCompare(b[0])));
      if (!Array.isArray(body.previous) || body.previous.some(t => !t || typeof t.id !== 'string' || !Number.isInteger(t.revision)) || snapshot(scope) !== snapshot(body.previous)) throw new AppError(409, 'Список изменился. Обновите его и повторите перемещение.');
      const parentId = body.parentId ?? null;
      if (parentId !== null && (typeof parentId !== 'string' || !/^[a-f0-9-]{36}$/.test(parentId))) throw new AppError(400, 'Некорректная родительская задача');
      const parent = parentId ? this.get(parentId) : null;
      if (parent && (parent.id === id || subtree.has(parent.id))) throw new AppError(400, 'Нельзя вложить задачу в себя или её дочернюю задачу');
      if (parent && (parent.completedAt || (parent.projectId ?? null) !== (task.projectId ?? null))) throw new AppError(400, 'Выберите незавершённую задачу в том же проекте');
      const sectionId = parent ? parent.sectionId ?? null : body.sectionId === undefined ? task.sectionId ?? null : body.sectionId;
      this.placement(task.projectId ?? null, sectionId);
      let depth = 0, ancestor = parent;
      while (ancestor) { if (++depth > 10) throw new AppError(400, 'Не более 10 уровней вложенности'); ancestor = all.find(t => t.id === ancestor.parentId); }
      for (const child of all.filter(t => subtree.has(t.id))) {
        let d = depth + 1, a = child; while (a.parentId && a.parentId !== id) { d++; a = all.find(t => t.id === a.parentId); }
        if (d > 10) throw new AppError(400, 'Не более 10 уровней вложенности');
      }
      const siblings = all.filter(t => t.id !== id && (t.parentId ?? null) === parentId && (t.projectId ?? null) === (task.projectId ?? null) && (t.sectionId ?? null) === sectionId).sort(compareTasks);
      const index = body.beforeId == null ? siblings.length : siblings.findIndex(t => t.id === body.beforeId);
      if (index < 0) throw new AppError(400, 'Место перемещения не найдено');
      siblings.splice(index, 0, { ...task, parentId, sectionId });
      const changed = new Map(siblings.map((t, position) => [t.id, { ...t, position }]));
      for (const t of all) if (subtree.has(t.id)) changed.set(t.id, { ...t, sectionId });
      for (const t of changed.values()) { const old=all.find(previous => previous.id===t.id); if (JSON.stringify(t)!==JSON.stringify(old)) this.writeTask({ ...t, revision:t.revision + 1, updatedAt:new Date().toISOString() }); }
      this.db.exec('COMMIT'); return this.get(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  writeTask(task) { this.db.prepare('UPDATE tasks SET data=?,revision=? WHERE id=?').run(JSON.stringify(task), task.revision, task.id); }
  close() { this.db.close(); }
  list() { return this.db.prepare('SELECT data FROM tasks').all().map(r => JSON.parse(r.data)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) { const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id); if (!row) throw new AppError(404, 'Задача не найдена'); return JSON.parse(row.data); }
  create(parsed) {
    const now = new Date().toISOString();
    if (parsed.parentId != null && (typeof parsed.parentId !== 'string' || !/^[a-f0-9-]{36}$/.test(parsed.parentId))) throw new AppError(400, 'Некорректная родительская задача');
    const parent = parsed.parentId ? this.get(parsed.parentId) : null;
    if (parent?.completedAt) throw new AppError(400, 'Родительская задача уже выполнена');
    let ancestor = parent, depth = 0; while (ancestor) { if (++depth > 10) throw new AppError(400, 'Не более 10 уровней вложенности'); ancestor = ancestor.parentId ? this.get(ancestor.parentId) : null; }
    const placement = parent || parsed;
    const siblings = this.list().filter(t => (t.parentId ?? null) === (parsed.parentId ?? null) && (t.projectId ?? null) === (placement.projectId ?? null) && (t.sectionId ?? null) === (placement.sectionId ?? null));
    const position = Math.min(0, ...siblings.map(t => t.position ?? 0)) - 1;
    const task = { description: '', projectId:null, sectionId:null, parentId: null, position, ...parsed, ...(parent ? { projectId:parent.projectId, sectionId:parent.sectionId } : {}), id: randomUUID(), revision: 1, createdAt: now, updatedAt: now, completedAt: null };
    this.db.prepare('INSERT INTO tasks VALUES (?,?,?)').run(task.id, JSON.stringify(task), 1);
    return task;
  }
  mutate(id, revision, change) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.get(id);
      if (task.revision !== revision) throw new AppError(409, 'Задача изменилась в другом окне. Обновите список.');
      const next = change(task);
      if (next === null) {
        for (const child of this.list().filter(t => t.parentId === id)) this.writeTask({ ...child, parentId:task.parentId ?? null, revision:child.revision + 1 });
        this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      }
      else {
        if ((next.projectId ?? null) !== (task.projectId ?? null) || (next.sectionId ?? null) !== (task.sectionId ?? null)) {
          next.parentId = null;
          const all = this.list(), children = descendants(all, id);
          for (const child of all.filter(t => children.has(t.id))) this.writeTask({ ...child, projectId:next.projectId, sectionId:next.sectionId, revision:child.revision + 1, updatedAt:new Date().toISOString() });
        }
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
  history(full = false) { return this.db.prepare('SELECT completed_at,snapshot FROM completions ORDER BY completed_at DESC' + (full ? '' : ' LIMIT 100')).all().map(r => ({ completedAt: r.completed_at, task: JSON.parse(r.snapshot) })); }
}
