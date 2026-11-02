import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';

const password = 'test-only-password-123';
async function start(database = ':memory:', options = {}) {
  const app = createApp({ password, database, ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const request = async (path, body, method = body ? 'POST' : 'GET', extraHeaders = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
    return { response, data: await response.json() };
  };
  return { ...app, base, request, login: async () => { const result = await request('/api/login', { password }); cookie = result.response.headers.get('set-cookie').split(';')[0]; return result; }, close: () => new Promise(resolve => app.server.close(resolve)) };
}
test('authenticated task lifecycle, stale revisions, recurrence and undo', async t => {
  const app = await start(); t.after(() => app.close());
  assert.equal((await app.request('/api/tasks')).response.status, 401);
  assert.equal((await app.request('/api/login', { password: 'wrong' })).response.status, 401);
  const login = await app.login(); assert.match(login.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const preview = (await app.request('/api/parse', { source: 'Полив каждые 3 дня', timezone: 'Europe/Moscow' })).data;
  const created = await app.request('/api/tasks', { source: 'Полив каждые 3 дня', reference: preview.reference });
  assert.equal(created.response.status, 201); let task = created.data.task;
  assert.deepEqual(task.due, preview.parsed.due); assert.equal(task.title, 'Полив');
  const renamed = await app.request(`/api/tasks/${task.id}`, { title: 'Полить цветы', revision: task.revision }, 'PATCH');
  assert.deepEqual(renamed.data.task.due, task.due); task = renamed.data.task;
  const complete = await app.request(`/api/tasks/${task.id}/complete`, { revision: task.revision });
  assert.equal(complete.response.status, 200); assert.equal(complete.data.task.completedAt, null);
  assert.notEqual(complete.data.task.due.date, task.due.date);
  assert.equal((await app.request(`/api/tasks/${task.id}/complete`, { revision: task.revision })).response.status, 409);
  assert.equal((await app.request('/api/history')).data.history.length, 1);
  const undo = await app.request(`/api/tasks/${task.id}/undo`, { revision: complete.data.task.revision });
  assert.deepEqual(undo.data.task.due, task.due); assert.equal((await app.request('/api/history')).data.history.length, 0);
  task = undo.data.task;
  const clear = await app.request(`/api/tasks/${task.id}`, { title: task.title, revision: task.revision, clearSchedule: true }, 'PATCH');
  assert.equal(clear.data.task.recurrence, null); assert.equal(clear.data.task.due, null); task = clear.data.task;
  const done = (await app.request(`/api/tasks/${task.id}/complete`, { revision: task.revision })).data.task;
  assert.ok(done.completedAt);
  const exported = await app.request('/api/export'); assert.equal(exported.data.tasks.length, 1); assert.match(exported.response.headers.get('content-disposition'), /attachment/);
  assert.equal((await app.request(`/api/tasks/${task.id}`, { revision: done.revision }, 'DELETE')).response.status, 200);
  assert.equal((await app.request('/api/tasks')).data.tasks.length, 0);
  await app.request('/api/logout', {}); assert.equal((await app.request('/api/tasks')).response.status, 401);
});
test('invalid input, cross-origin requests and limits', async t => {
  const app = await start(); t.after(() => app.close()); await app.login();
  assert.equal((await app.request('/api/tasks', { source: 'test' }, 'POST', { Origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await app.request('/api/tasks', { source: 'every 0 days' })).response.status, 422);
  assert.equal((await app.request('/api/tasks', { source: 'tomorrow' })).response.status, 422);
  assert.equal((await app.request('/api/parse', { source: 'x'.repeat(501) })).response.status, 400);
  assert.equal((await app.request('/api/parse', { source: 'test', timezone: 'No/Zone' })).response.status, 400);
  assert.equal((await app.request('/api/tasks', { source: 'test', reference: '2000-01-01' })).response.status, 400);
  assert.equal((await app.request('/api/parse', { source: 'x'.repeat(17000) })).response.status, 413);
  const index = await fetch(app.base); assert.equal(index.status, 200); assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${app.base}/.env`)).status, 404);
});
test('tasks persist through restart and a password change invalidates sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendoist-test-')); const database = join(dir, 'db.sqlite');
  let app;
  try {
    app = await start(database); const login = await app.login(); const oldCookie = login.response.headers.get('set-cookie').split(';')[0];
    const original = (await app.request('/api/tasks', { source: 'Сохранить данные завтра' })).data.task;
    await app.close(); app = await start(database, { password: 'new-test-password-456' });
    const response = await app.request('/api/tasks', undefined, 'GET', { Cookie: oldCookie }); assert.equal(response.response.status, 401);
    assert.equal(app.store.list()[0].id, original.id);
  } finally { if (app?.server.listening) await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('HTTPS public origin produces Secure cookie and allows same-origin requests', async t => {
  const app = await start(':memory:', { publicUrl: 'https://tasks.example.com' }); t.after(() => app.close());
  const result = await app.request('/api/login', { password }, 'POST', { Origin: 'https://tasks.example.com' });
  assert.equal(result.response.status, 200); assert.match(result.response.headers.get('set-cookie'), /Secure/);
});
test('login attempts are rate limited', async t => {
  const app = await start(); t.after(() => app.close());
  for (let i = 0; i < 10; i++) await app.request('/api/login', { password: 'bad' });
  assert.equal((await app.request('/api/login', { password })).response.status, 429);
});
test('editing the schedule preserves an existing deadline', async t => {
  const app = await start(); t.after(() => app.close()); await app.login();
  const original = (await app.request('/api/tasks', { source: 'Отчёт завтра {28 фев.}' })).data.task;
  const changed = (await app.request(`/api/tasks/${original.id}`, { title: 'Отчёт', revision: original.revision, source: 'Task every Friday' }, 'PATCH')).data.task;
  assert.deepEqual(changed.deadline, original.deadline); assert.equal(changed.recurrence.frequency, 'WEEKLY');
});
test('online backup script produces a restorable SQLite snapshot', async () => {
  const { execFileSync } = await import('node:child_process');
  const { Store } = await import('../server/store.js');
  const dir = mkdtempSync(join(tmpdir(), 'opendoist-backup-')); const database = join(dir, 'db.sqlite'), snapshot = join(dir, 'backup.sqlite');
  const store = new Store(database);
  try {
    const original = store.create({ title: 'Backup test', due: null, recurrence: null });
    execFileSync(process.execPath, ['server/backup.js', snapshot], { env: { DATABASE_PATH: database }, stdio: 'pipe' });
    const restored = new Store(snapshot);
    try { assert.equal(restored.list()[0].id, original.id); } finally { restored.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('settings require authentication, validate atomically and persist for another client after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendoist-settings-')), database = join(dir, 'db.sqlite');
  let app;
  try {
    app = await start(database);
    assert.equal((await app.request('/api/settings')).response.status, 401);
    assert.equal((await app.request('/api/settings', { theme: 'dark' }, 'PATCH')).response.status, 401);
    await app.login();
    assert.equal((await app.request('/api/settings')).data.settings.theme, 'system');
    assert.equal((await app.request('/api/settings')).data.settings.submitShortcut, 'enter');
    const saved = { submitShortcut: 'ctrl-enter', theme: 'dark', accent: '#167eaa', timezone: 'Asia/Tokyo', language: 'en' };
    assert.deepEqual((await app.request('/api/settings', saved, 'PATCH')).data.settings, saved);
    for (const patch of [{ theme: 'invalid' }, { accent: 'red' }, { accent: null }, { timezone: 'No/Zone' }, { timezone: null }, { language: 'xx' }, { submitShortcut: 'space' }, { unknown: true }]) {
      assert.equal((await app.request('/api/settings', patch, 'PATCH')).response.status, 400);
      assert.deepEqual((await app.request('/api/settings')).data.settings, saved);
    }
    assert.equal((await app.request('/api/settings', { theme: 'light' }, 'PATCH', { Origin: 'https://evil.example' })).response.status, 403);
    await app.close(); app = await start(database); await app.login();
    assert.deepEqual((await app.request('/api/settings')).data.settings, saved);
    const otherLogin = await fetch(`${app.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0];
    const other = await fetch(`${app.base}/api/settings`, { headers: { Cookie: otherCookie } });
    assert.deepEqual((await other.json()).settings, saved);
    const updated = (await app.request('/api/settings', { theme: 'system' }, 'PATCH')).data.settings;
    assert.deepEqual(updated, { ...saved, theme: 'system' });
  } finally { if (app?.server.listening) await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('notification API protects credentials and reminder mutations with session, origin and revision checks', async t => {
  const app = await start(':memory:', { notificationSender: async () => {} }); t.after(() => app.close());
  assert.equal((await app.request('/api/notifications')).response.status, 401);
  await app.login();
  const cfg = await app.request('/api/notifications', { telegram: { enabled: true, token: '12345:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chatId: '123456' } }, 'PATCH');
  assert.equal(cfg.response.status, 200); assert.equal(cfg.data.config.telegram.token, undefined); assert.equal(cfg.data.config.telegram.tokenSet, true);
  assert.doesNotMatch(JSON.stringify((await app.request('/api/notifications')).data), /aaaaaaaaaa/);
  assert.equal((await app.request('/api/notifications/test', { channel: 'telegram' })).response.status, 200);
  let task = (await app.request('/api/tasks', { source: 'Встреча завтра в 15' })).data.task;
  const body = { kind: 'before', minutes: 30, channels: ['telegram'], revision: task.revision };
  const created = await app.request(`/api/tasks/${task.id}/reminders`, body);
  assert.equal(created.response.status, 201); task = created.data.task; assert.equal(task.reminders.length, 1);
  assert.equal((await app.request(`/api/tasks/${task.id}/reminders`, body)).response.status, 409);
  assert.equal((await app.request(`/api/tasks/${task.id}/reminders`, { ...body, revision: task.revision }, 'POST', { Origin: 'https://evil.example' })).response.status, 403);
  const removed = await app.request(`/api/tasks/${task.id}/reminders/${task.reminders[0].id}`, { revision: task.revision }, 'DELETE');
  assert.equal(removed.data.task.reminders.length, 0);
  assert.doesNotMatch(JSON.stringify((await app.request('/api/export')).data), /aaaaaaaaaa/);
});

test('export import previews and restores tasks, recurrence, reminders and history without changing existing tasks', async t => {
  const source = await start(), target = await start(); t.after(() => source.close()); t.after(() => target.close());
  await source.login(); await target.login();
  await source.request('/api/notifications', { telegram: { enabled: true, token: '12345:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chatId: '123456' } }, 'PATCH');
  let recurring = (await source.request('/api/tasks', { source: 'Полив каждый день в 10' })).data.task;
  recurring = (await source.request(`/api/tasks/${recurring.id}/reminders`, { revision: recurring.revision, kind: 'absolute', local: '2099-01-01T10:00', timezone: 'Europe/Moscow', channels: ['telegram'] })).data.task;
  await source.request(`/api/tasks/${recurring.id}/complete`, { revision: recurring.revision });
  let done = (await source.request('/api/tasks', { source: 'Прочитать книгу' })).data.task;
  await source.request(`/api/tasks/${done.id}/complete`, { revision: done.revision });
  const backup = (await source.request('/api/export')).data;
  const preview = await target.request('/api/import/preview', backup);
  assert.deepEqual(preview.data, { added: 2, skipped: 0, history: 2 });
  assert.equal(target.store.list().length, 0);
  assert.deepEqual((await target.request('/api/import', backup)).data, preview.data);
  for (const original of backup.tasks) {
    const imported = target.store.get(original.id);
    for (const key of ['title', 'due', 'recurrence', 'completedAt', 'revision', 'createdAt']) assert.deepEqual(imported[key], original[key]);
  }
  const restored = target.store.get(recurring.id);
  assert.notEqual(restored.reminders[0].id, recurring.reminders[0].id);
  assert.ok(restored.reminders[0].createdAt >= recurring.reminders[0].createdAt);
  assert.equal(target.store.history().length, 2);
  assert.equal(target.store.notificationConfig(), null);
  assert.equal(target.store.db.prepare('SELECT count(*) AS count FROM notification_outbox').get().count, 0);
  await target.request(`/api/tasks/${restored.id}`, { revision: restored.revision, title: 'Изменено после импорта' }, 'PATCH');
  assert.deepEqual((await target.request('/api/import', backup)).data, { added: 0, skipped: 2, history: 0 });
  assert.equal(target.store.get(restored.id).title, 'Изменено после импорта');
  assert.equal(target.store.history().length, 2);
  const doneRestored = target.store.get(done.id);
  const undone = await target.request(`/api/tasks/${done.id}/undo`, { revision: doneRestored.revision });
  assert.equal(undone.response.status, 200); assert.equal(undone.data.task.completedAt, null);
});

test('import rejects malformed schedules atomically, requires authentication and checks Origin', async t => {
  const app = await start(); t.after(() => app.close());
  const empty = { version: 1, tasks: [], history: [] };
  assert.equal((await app.request('/api/import', empty)).response.status, 401);
  assert.equal((await app.request('/api/import/preview', empty)).response.status, 401);
  await app.login();
  const task = (await app.request('/api/tasks', { source: 'Задача завтра в 10' })).data.task;
  const original = { ...task, id: '11111111-1111-4111-8111-111111111111' };
  const invalids = [
    { ...empty, version: 2 },
    { ...empty, tasks: [original, original] },
    { ...empty, tasks: [original, { ...original, id: 'bad' }] },
    { ...empty, tasks: [{ ...original, due: { ...original.due, timezone: 'No/Zone' } }] },
    { ...empty, tasks: [{ ...original, due: { ...original.due, date: '2030-02-31' } }] },
    { ...empty, tasks: [{ ...original, recurrence: { mode: 'calendar' } }] },
    { ...empty, tasks: [{ ...original, reminders: [{ kind: 'invalid' }] }] },
    { ...empty, history: [{ completedAt: new Date().toISOString(), task: original }] },
  ];
  for (const input of invalids) {
    assert.equal((await app.request('/api/import', input)).response.status, 400);
    assert.equal(app.store.list().length, 1);
  }
  assert.equal((await app.request('/api/import', empty, 'POST', { Origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await app.request('/api/import', { ...empty, padding: 'x'.repeat(10 * 1024 * 1024) })).response.status, 413);
});

test('import accepts exports over the ordinary request limit and rolls back storage failures', async t => {
  const app = await start(); t.after(() => app.close()); await app.login();
  const original = (await app.request('/api/tasks', { source: 'Task every 3rd Friday at 10am' })).data.task;
  const document = { version: 1, tasks: Array.from({ length: 60 }, (_, i) => ({ ...original, id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}` })), history: [] };
  assert.ok(JSON.stringify(document).length > 16384);
  assert.equal((await app.request('/api/import/preview', document)).data.added, 60);
  app.store.db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON tasks WHEN NEW.id='11111111-1111-4111-8111-000000000001' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.equal((await app.request('/api/import', document)).response.status, 500); assert.equal(app.store.list().length, 1);
  app.store.db.exec('DROP TRIGGER reject_import');
  assert.equal((await app.request('/api/import', document)).data.added, 60);
  assert.equal(app.store.list().length, 61);
});

test('projects and sections support icons, revision checks, task moves, export and non-destructive removal', async t => {
  const app = await start(), target = await start(); t.after(() => app.close()); t.after(() => target.close());
  assert.equal((await app.request('/api/projects')).response.status, 401); await app.login(); await target.login();
  const fields = { name: 'Работа', iconType: 'emoji', emoji: '💼', color: '#3478cb' };
  let project = (await app.request('/api/projects', fields)).data.entity;
  assert.ok(project.id); assert.equal(project.emoji, '💼');
  const section = (await app.request('/api/sections', { ...fields, name: 'В процессе', projectId: project.id, iconType: 'color' })).data.entity;
  let task = (await app.request('/api/tasks', { source: 'Отчёт завтра', projectId: project.id, sectionId: section.id })).data.task;
  assert.equal(task.sectionId, section.id);
  assert.equal((await app.request('/api/tasks', { source: 'Bad', sectionId: section.id })).response.status, 400);
  assert.equal((await app.request('/api/projects', fields)).response.status, 409);
  assert.equal((await app.request('/api/projects', { ...fields, name: 'Bad', emoji: 'text' })).response.status, 400);
  const backup = (await app.request('/api/export')).data;
  const imported = (await target.request('/api/import', backup)).data;
  assert.equal(imported.projects, 1); assert.equal(imported.sections, 1);
  assert.equal(target.store.get(task.id).sectionId, section.id);
  project = (await app.request(`/api/projects/${project.id}`, { ...fields, name: 'Работа 2', revision: project.revision }, 'PATCH')).data.entity;
  assert.equal((await app.request(`/api/projects/${project.id}`, { ...fields, revision: 1 }, 'PATCH')).response.status, 409);
  await app.request(`/api/sections/${section.id}`, { revision: section.revision }, 'DELETE');
  task = app.store.get(task.id); assert.equal(task.sectionId, null); assert.equal(task.projectId, project.id);
  await app.request(`/api/projects/${project.id}`, { revision: project.revision }, 'DELETE');
  task = app.store.get(task.id); assert.equal(task.projectId, null); assert.equal(task.title, 'Отчёт');
  assert.equal((await app.request('/api/projects')).data.projects.length, 0);
});

test('project ordering persists, rejects stale lists and survives edits and imports', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'opendoist-order-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'tasks.sqlite');
  const app = await start(database); await app.login();
  const fields = { iconType: 'color', color: '#112233' };
  const a = (await app.request('/api/projects', { ...fields, name: 'A' })).data.entity;
  const b = (await app.request('/api/projects', { ...fields, name: 'B' })).data.entity;
  assert.equal((await app.request('/api/projects/order', { ids: [a.id, a.id], previousIds: [a.id,b.id] }, 'PATCH')).response.status, 400);
  assert.equal((await app.request('/api/projects/order', { ids: [b.id,a.id], previousIds: [a.id,b.id] }, 'PATCH')).response.status, 200);
  assert.equal((await app.request('/api/projects/order', { ids: [a.id,b.id], previousIds: [a.id,b.id] }, 'PATCH')).response.status, 409);
  await app.request(`/api/projects/${b.id}`, { ...fields, name: 'B edited', revision: b.revision }, 'PATCH');
  const c = (await app.request('/api/projects', { ...fields, name: 'C' })).data.entity;
  assert.deepEqual((await app.request('/api/projects')).data.projects.map(p => p.id), [b.id,a.id,c.id]);
  const exported = (await app.request('/api/export')).data;
  await app.close();
  const reopened = await start(database); t.after(() => reopened.close()); await reopened.login();
  assert.deepEqual((await reopened.request('/api/projects')).data.projects.map(p => p.id), [b.id,a.id,c.id]);
  const target = await start(); t.after(() => target.close()); await target.login();
  await target.request('/api/import', exported);
  assert.deepEqual((await target.request('/api/projects')).data.projects.map(p => p.id), [b.id,a.id,c.id]);
});

test('project layouts persist with revision checks, edits and JSON transfer', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'opendoist-layout-')); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const database = join(dir, 'tasks.sqlite'), app = await start(database); await app.login();
  const fields = { name:'Layout', iconType:'color', color:'#334455' };
  let project = (await app.request('/api/projects',fields)).data.entity;
  const endpoint = `/api/projects/${project.id}/view`;
  assert.equal((await app.request(endpoint, {revision:project.revision,view:{layout:'bad'}}, 'PATCH')).response.status,400);
  project = (await app.request(endpoint, {revision:project.revision,view:{layout:'calendar',calendar:'week'}}, 'PATCH')).data.project;
  assert.equal((await app.request(endpoint, {revision:1,view:{layout:'list'}}, 'PATCH')).response.status,409);
  project = (await app.request(`/api/projects/${project.id}`, {...fields,name:'Renamed',revision:project.revision}, 'PATCH')).data.entity;
  assert.deepEqual(project.view, {layout:'calendar',calendar:'week'});
  const exported = (await app.request('/api/export')).data; await app.close();
  const reopened = await start(database); t.after(() => reopened.close()); await reopened.login();
  assert.deepEqual((await reopened.request('/api/projects')).data.projects[0].view,project.view);
  const target = await start(); t.after(() => target.close()); await target.login(); await target.request('/api/import',exported);
  assert.deepEqual((await target.request('/api/projects')).data.projects[0].view,project.view);
});
test('calendar reschedule endpoint rejects unauthenticated and stale changes', async t => {
  const app = await start(); t.after(() => app.close());
  assert.equal((await app.request('/api/tasks/123/reschedule',{date:'2026-11-02',revision:1})).response.status,401);
  await app.login(); let task = (await app.request('/api/tasks',{source:'Встреча завтра в 10'})).data.task;
  const url = `/api/tasks/${task.id}/reschedule`;
  assert.equal((await app.request(url,{revision:task.revision,date:'not-date'})).response.status,400);
  const moved = await app.request(url,{revision:task.revision,date:'2027-01-05',time:'12:30',timezone:'Europe/Moscow'});
  assert.equal(moved.response.status,200); assert.equal(moved.data.task.due.date,'2027-01-05'); assert.equal(moved.data.task.due.time,'12:30');
  assert.equal((await app.request(url,{revision:task.revision,date:'2027-01-06'})).response.status,409);
  assert.equal((await app.request(url,{revision:moved.data.task.revision,date:null})).data.task.due,null);
});
