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
    const note = store.saveNote({title:'Backup note',body:'# Markdown\n\nБез даты'});
    execFileSync(process.execPath, ['server/backup.js', snapshot], { env: { DATABASE_PATH: database }, stdio: 'pipe' });
    const restored = new Store(snapshot);
    try { assert.equal(restored.list()[0].id, original.id); assert.deepEqual(restored.note(note.id),note); } finally { restored.close(); }
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
    const saved = { startPage:'today', darkPalette:'graphite', submitShortcut: 'ctrl-enter', theme: 'dark', accent: '#167eaa', timezone: 'Asia/Tokyo', language: 'en' };
    assert.deepEqual((await app.request('/api/settings', saved, 'PATCH')).data.settings, saved);
    for (const patch of [{ startPage:'invalid' }, { darkPalette:'invalid' }, { theme: 'invalid' }, { accent: 'red' }, { accent: null }, { timezone: 'No/Zone' }, { timezone: null }, { language: 'xx' }, { submitShortcut: 'space' }, { unknown: true }]) {
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
  assert.equal(created.response.status, 201); task = created.data.task; assert.equal(task.reminders.length, 2);
  assert.equal((await app.request(`/api/tasks/${task.id}/reminders`, body)).response.status, 409);
  assert.equal((await app.request(`/api/tasks/${task.id}/reminders`, { ...body, revision: task.revision }, 'POST', { Origin: 'https://evil.example' })).response.status, 403);
  const removed = await app.request(`/api/tasks/${task.id}/reminders/${task.reminders[1].id}`, { revision: task.revision }, 'DELETE');
  assert.equal(removed.data.task.reminders.length, 1);
  assert.equal(removed.data.task.reminders[0].minutes, 10);
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

test('task descriptions and attachments: authenticated binary upload/download/delete', async t => {
 const app=await start(); t.after(()=>app.close()); const login=await app.login(); const cookie=login.response.headers.get('set-cookie').split(';')[0];
 let task=(await app.request('/api/tasks',{source:'Files task',description:'**Description**'})).data.task;
 assert.equal(task.description,'**Description**');
 const edited=await app.request(`/api/tasks/${task.id}`,{title:task.title,description:'New\n- note',revision:task.revision},'PATCH'); assert.equal(edited.response.status,200);task=edited.data.task;
 const url=`${app.base}/api/tasks/${task.id}/attachments`;
 const headers={'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent('файл.txt')};
 assert.equal((await fetch(url,{method:'POST',headers,body:'hello'})).status,401);
 assert.equal((await fetch(url,{method:'POST',headers:{...headers,Cookie:cookie,Origin:'https://evil.example'},body:'hello'})).status,403);
 const uploaded=await fetch(url,{method:'POST',headers:{...headers,Cookie:cookie},body:'hello'}); assert.equal(uploaded.status,201); const file=(await uploaded.json()).file;
 const download=await fetch(`${url}/${file.id}`,{headers:{Cookie:cookie}});assert.equal(await download.text(),'hello'); assert.equal(download.headers.get('content-type'),'application/octet-stream'); assert.match(download.headers.get('content-disposition'),/^attachment;/);
 assert.equal((await fetch(url,{method:'POST',headers:{...headers,Cookie:cookie,'X-File-Name':'..%2Fsecret'},body:'x'})).status,400);
 const other=(await app.request('/api/tasks',{source:'Other file task'})).data.task;
 assert.equal((await fetch(`${app.base}/api/tasks/${other.id}/attachments/${file.id}`,{headers:{Cookie:cookie}})).status,404);
 assert.equal((await app.request(`/api/tasks/${task.id}/attachments/${file.id}`,{},'DELETE')).response.status,200);
 assert.equal((await app.request(`/api/tasks/${task.id}/attachments`)).data.files.length,0);
});

test('backup API hides credentials and task move API rejects stale state',async t=>{
 const app=await start();t.after(()=>app.close());assert.equal((await app.request('/api/backups')).response.status,401);await app.login();
 const saved=await app.request('/api/backups',{target:'s3',bucket:'test-bucket',accessKeyId:'key',secretAccessKey:'secret'},'PATCH');assert.equal(saved.response.status,200);assert.equal(saved.data.config.hasCredentials,true);assert.equal(saved.data.config.secretAccessKey,undefined);
 const a=(await app.request('/api/tasks',{source:'Parent'})).data.task,b=(await app.request('/api/tasks',{source:'Child'})).data.task;
 const previous=(await app.request('/api/tasks')).data.tasks;
 const moved=await app.request(`/api/tasks/${b.id}/move`,{previous,parentId:a.id});assert.equal(moved.response.status,200);assert.equal(moved.data.task.parentId,a.id);
 assert.equal((await app.request(`/api/tasks/${a.id}/move`,{previous,parentId:null})).response.status,409);
});

test('backup connection check authenticates, enforces origin and does not save draft',async t=>{
 let tested;const app=await start(':memory:',{backupTester:async config=>{tested=config;return {ok:true,message:'Verified',warning:null};}});t.after(()=>app.close());
 assert.equal((await app.request('/api/backups/test',{})).response.status,401);await app.login();
 assert.equal((await app.request('/api/backups/test',{},'POST',{Origin:'https://evil.example'})).response.status,403);
 const before=(await app.request('/api/backups')).data.config;
 const result=await app.request('/api/backups/test',{folder:'/tmp/test-draft'});assert.equal(result.response.status,200);assert.equal(result.data.ok,true);assert.equal(tested.folder,'/tmp/test-draft');
 assert.deepEqual((await app.request('/api/backups')).data.config,before);assert.equal((await app.request('/api/backups/test',{folder:'relative'})).response.status,400);
});

test('built-in layouts persist independently and reject invalid settings atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendoist-views-')), database = join(dir, 'db.sqlite');
  let app;
  try {
    app = await start(database); await app.login();
    const views = {inbox:{layout:'board',calendar:'week'}, today:{layout:'calendar',calendar:'day',grouping:'categories'}, upcoming:{layout:'calendar',calendar:'month',grouping:'chronology'}};
    for (const [key,value] of Object.entries(views)) {
      assert.equal((await app.request('/api/settings', {views:{[key]:value}}, 'PATCH')).response.status, 200);
    }
    assert.deepEqual((await app.request('/api/settings')).data.settings.views, views);
    for (const bad of [null, [], {today:{layout:'list',calendar:'day',grouping:'invalid'}}, {inbox:{layout:'list',calendar:'month',grouping:'categories'}}, {all:{layout:'list',calendar:'month'}}, {today:{layout:'calendar',calendar:'week'}}, {inbox:{layout:'bad',calendar:'week'}}, {upcoming:{layout:'board',calendar:'bad'}}, {inbox:{layout:'board',calendar:'week',extra:1}}]) {
      assert.equal((await app.request('/api/settings', {views:bad}, 'PATCH')).response.status, 400);
      assert.deepEqual((await app.request('/api/settings')).data.settings.views, views);
    }
    await app.request('/api/settings', {theme:'dark'}, 'PATCH');
    await app.close(); app = await start(database); await app.login();
    assert.deepEqual((await app.request('/api/settings')).data.settings.views, views);
  } finally { if (app?.server.listening) await app.close(); rmSync(dir, {recursive:true,force:true}); }
});

test('new recurrence rules survive API completion, undo, export and import', async t => {
  const app=await start(); t.after(()=>app.close()); await app.login();
  const phrases=['every 14 jan, 14 apr, 15 jun, 15 sep','every 1st wed jan, 3rd thu jul','every first workday','every last day','every 3 workday'];
  for(const phrase of phrases) {
    const created=await app.request('/api/tasks',{source:`Task ${phrase}`,timezone:'Europe/Moscow'});
    assert.equal(created.response.status,201,JSON.stringify(created.data));
    const task=created.data.task;
    const done=await app.request(`/api/tasks/${task.id}/complete`,{revision:task.revision});
    assert.equal(done.response.status,200); assert.deepEqual(done.data.task.recurrence,task.recurrence);
    assert.notDeepEqual(done.data.task.due,task.due);
    const undo=await app.request(`/api/tasks/${task.id}/undo`,{revision:done.data.task.revision});
    assert.equal(undo.response.status,200);assert.deepEqual(undo.data.task.due,task.due);
  }
  const exported=(await app.request('/api/export')).data;
  const {validateImport}=await import('../server/import.js');
  const restored=validateImport(exported);
  assert.deepEqual(restored.tasks.map(t=>t.recurrence),exported.tasks.map(t=>t.recurrence));
  const forged=structuredClone(exported); forged.tasks[0].recurrence.rrules=['RRULE:FREQ=YEARLY;COUNT=999999999'];
  forged.tasks[0].recurrence.rrule=forged.tasks[0].recurrence.rrules[0];
  assert.throws(()=>validateImport(forged),/правило/);
  const badBusiness=structuredClone(exported); const business=badBusiness.tasks.find(t=>t.recurrence.businessInterval); business.recurrence.businessInterval=-1;
  assert.throws(()=>validateImport(badBusiness),/интервал рабочих/);
});

test('notes persist without scheduling; revisions prevent overwrites and deletion conflicts', async () => {
  const dir=mkdtempSync(join(tmpdir(),'opendoist-notes-')), database=join(dir,'db.sqlite'); let app;
  try {
    app=await start(database);
    assert.equal((await app.request('/api/notes')).response.status,401);
    assert.equal((await app.request('/api/notes',{title:'Note',body:'text'})).response.status,401);
    await app.login();
    assert.equal((await app.request('/api/notes',{title:'Note',body:'text'},'POST',{Origin:'https://evil.example'})).response.status,403);
    assert.equal((await app.request('/api/notes',{title:' ',body:'text'})).response.status,400);
    assert.equal((await app.request('/api/notes',{title:'Note',body:42})).response.status,400);
    const created=await app.request('/api/notes',{title:'Завтра каждый день',body:'# Markdown\n\n**Текст**\n\n<script>alert(1)</script>',due:{date:'2030-01-01'}});
    assert.equal(created.response.status,201); const note=created.data.note;
    assert.deepEqual(Object.keys(note).sort(),['body','id','revision','title']);
    assert.equal(app.store.list().length,0);
    assert.deepEqual((await app.request('/api/notes')).data.notes,[{id:note.id,title:note.title,revision:1}]);
    const edited=await app.request(`/api/notes/${note.id}`,{title:'Новый заголовок',body:'новый текст',revision:1},'PATCH');
    assert.equal(edited.data.note.revision,2);
    assert.equal((await app.request(`/api/notes/${note.id}`,{title:'stale',body:'stale',revision:1},'PATCH')).response.status,409);
    assert.equal((await app.request(`/api/notes/${note.id}`,{revision:1},'DELETE')).response.status,409);
    await app.close();app=await start(database);await app.login();
    assert.deepEqual((await app.request(`/api/notes/${note.id}`)).data.note,edited.data.note);
    assert.equal((await app.request(`/api/notes/${note.id}`,{revision:2},'DELETE')).response.status,200);
    assert.equal((await app.request(`/api/notes/${note.id}`)).response.status,404);
  } finally {if(app?.server.listening)await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('notes larger than the old import limit round-trip without truncation', async t => {
  const source=await start(), target=await start();t.after(()=>source.close());t.after(()=>target.close());await source.login();await target.login();
  const body='# Большая заметка\n\n'+'Текст без дат.\n'.repeat(850000);
  assert.ok(Buffer.byteLength(body)>10*1024*1024);
  const created=await source.request('/api/notes',{title:'Длинный Markdown',body});assert.equal(created.response.status,201);
  const note=created.data.note;
  assert.equal((await source.request(`/api/notes/${note.id}`)).data.note.body,body);
  assert.equal(JSON.stringify((await source.request('/api/notes')).data).length<300,true);
  const exported=(await source.request('/api/export')).data;
  const preview=await target.request('/api/import/preview',exported);assert.equal(preview.data.notes,1);assert.equal(target.store.notes().length,0);
  assert.equal((await target.request('/api/import',exported)).data.notes,1);
  assert.deepEqual((await target.request(`/api/notes/${note.id}`)).data.note,note);
  assert.equal((await target.request('/api/import',exported)).data.notesSkipped,1);
  const invalid={...exported,notes:[note,{...note,id:'invalid'}]};assert.equal((await target.request('/api/import',invalid)).response.status,400);
  const legacy={version:1,tasks:[],history:[],projects:[],sections:[]};assert.equal((await target.request('/api/import',legacy)).response.status,200);
});


test('global search covers placements, completed tasks, full note bodies and older history with authentication', async t => {
  const app=await start();t.after(()=>app.close());
  assert.equal((await app.request('/api/search?q=test')).response.status,401);
  await app.login();
  const project=app.store.saveEntity('project',{name:'Работа',iconType:'color',color:'#c95736'});
  const section=app.store.saveEntity('section',{name:'Релизы',projectId:project.id,iconType:'color',color:'#c95736'});
  const task=app.store.create({title:'Обсудить',description:'Отчёт за месяц',projectId:project.id,sectionId:section.id});
  const done=app.store.create({title:'Старый отчёт'});app.store.complete(done.id,done.revision);
  const note=app.store.saveNote({title:'Протокол',body:'## Подробный отчёт за месяц'});
  const search=async q=>(await app.request('/api/search?q='+encodeURIComponent(q))).data;
  const found=await search('ОТЧЕТ');
  assert.equal(found.groups.tasks.items[0].id,task.id);
  assert.equal(found.groups.completed.items[0].id,done.id);
  assert.equal(found.groups.notes.items[0].id,note.id);
  assert.equal(found.groups.notes.items[0].body,undefined);
  assert.equal(found.groups.history.total,1);
  assert.equal((await search('РАБОТА')).groups.projects.items[0].id,project.id);
  assert.equal((await search('работа')).groups.tasks.items[0].id,task.id);
  assert.equal((await search('релизы')).groups.sections.items[0].id,section.id);
  assert.equal((await search('месяц отчет')).groups.notes.total,1);
  assert.equal((await search('неизвестное')).total,0);
  assert.equal((await search('   ')).total,0);
  assert.equal((await app.request('/api/search?q='+ 'a'.repeat(201))).response.status,400);
  for(let i=0;i<101;i++){const item=app.store.create({title:'Повтор истории'});app.store.complete(item.id,item.revision);}
  assert.equal((await search('Старый')).groups.history.total,1);
  const many=await search('Повтор');assert.equal(many.groups.completed.total,101);assert.equal(many.groups.completed.items.length,50);
});

test('default reminders are persisted on creation and first time assignment but respect removal', async t => {
  const app=await start();t.after(()=>app.close());await app.login();
  const config=app.notifications.config();config.email.enabled=true;app.store.saveNotificationConfig(config);
  let task=(await app.request('/api/tasks',{source:'Встреча завтра в 15:00',timezone:'UTC'})).data.task;
  assert.equal(task.reminders[0].minutes,10);assert.deepEqual(task.reminders[0].channels,['email']);
  task=(await app.request(`/api/tasks/${task.id}/reminders/${task.reminders[0].id}`,{revision:task.revision},'DELETE')).data.task;
  task=(await app.request(`/api/tasks/${task.id}`,{title:'Встреча новая',revision:task.revision},'PATCH')).data.task;
  assert.deepEqual(task.reminders,[]);
  let untimed=(await app.request('/api/tasks',{source:'Позвонить завтра',timezone:'UTC'})).data.task;
  assert.equal(untimed.reminders,undefined);
  untimed=(await app.request(`/api/tasks/${untimed.id}`,{title:untimed.title,revision:untimed.revision,source:'Позвонить завтра в 16:00',timezone:'UTC'},'PATCH')).data.task;
  assert.equal(untimed.reminders[0].minutes,10);
});

test('explicit unscheduled creation preserves the full source and bypasses only date parsing', async t => {
  const app=await start();t.after(()=>app.close());await app.login();
  const source='Подумать о философии слова `за 10 мин до`';
  assert.equal((await app.request('/api/tasks',{source})).response.status,422);
  const project=(await app.request('/api/projects',{name:'Работа',iconType:'color',color:'#c95736',emoji:''})).data.entity;
  const saved=await app.request('/api/tasks',{source,withoutSchedule:true,projectId:project.id});
  assert.equal(saved.response.status,201);const task=saved.data.task;
  assert.equal(task.title,source);assert.equal(task.source,source);assert.equal(task.projectId,project.id);
  assert.equal(task.due,null);assert.equal(task.recurrence,null);assert.equal(task.deadline,null);assert.equal(task.status,'unscheduled');
  assert.equal((await app.request('/api/tasks',{source:' ',withoutSchedule:true})).response.status,400);
  assert.equal((await app.request('/api/tasks',{source:'x'.repeat(501),withoutSchedule:true})).response.status,400);
  assert.equal((await app.request('/api/tasks',{source,withoutSchedule:'yes'})).response.status,400);
});

test('password change verifies current credentials, revokes other sessions and survives restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'opendoist-account-')),db=join(dir,'data.sqlite');
  let app=await start(db);t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const newPassword='new-test-password-456';
  assert.equal((await app.request('/api/account/password',{currentPassword:password,newPassword,confirmPassword:newPassword})).response.status,401);
  await app.login();
  const another=await app.request('/api/login',{password});const otherCookie=another.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await app.request('/api/account/password',{currentPassword:'wrong',newPassword,confirmPassword:newPassword})).response.status,403);
  assert.equal((await app.request('/api/account/password',{currentPassword:password,newPassword:'short',confirmPassword:'short'})).response.status,400);
  assert.equal((await app.request('/api/account/password',{currentPassword:password,newPassword,confirmPassword:'different'})).response.status,400);
  assert.equal((await app.request('/api/account/password',{currentPassword:password,newPassword,confirmPassword:newPassword},'POST',{Origin:'https://evil.example'})).response.status,403);
  const result=await app.request('/api/account/password',{currentPassword:password,newPassword,confirmPassword:newPassword});assert.equal(result.response.status,200);
  const freshCookie=result.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await app.request('/api/session',undefined,'GET',{Cookie:otherCookie})).response.status,401);
  assert.equal((await app.request('/api/session',undefined,'GET',{Cookie:freshCookie})).response.status,200);
  assert.equal((await app.request('/api/login',{password})).response.status,401);
  assert.doesNotMatch(JSON.stringify(app.store.db.prepare('SELECT * FROM account_auth').get()),new RegExp(newPassword));
  await app.close();app=await start(db); // original environment password still passed by start()
  assert.equal((await app.request('/api/login',{password})).response.status,401);
  assert.equal((await app.request('/api/login',{password:newPassword})).response.status,200);
});

test('editor parses changed titles, preserves ordinary names and prioritizes explicit schedule',async t=>{
 const app=await start();t.after(()=>app.close());await app.login();
 let task=(await app.request('/api/tasks',{source:'Встреча'})).data.task;
 task=(await app.request(`/api/tasks/${task.id}`,{revision:task.revision,title:'Встреча завтра в 15:00',parseTitle:true,timezone:'UTC'},'PATCH')).data.task;
 assert.equal(task.title,'Встреча');assert.equal(task.due.time,'15:00');const due=task.due;
 task=(await app.request(`/api/tasks/${task.id}`,{revision:task.revision,title:'Обычное новое название',parseTitle:true,timezone:'UTC'},'PATCH')).data.task;
 assert.deepEqual(task.due,due);assert.equal(task.title,'Обычное новое название');
 const literal='Подумать о слове `за 10 мин до`';
 task=(await app.request(`/api/tasks/${task.id}`,{revision:task.revision,title:literal,parseTitle:true,timezone:'UTC'},'PATCH')).data.task;
 assert.equal(task.title,literal);assert.deepEqual(task.due,due);
 task=(await app.request(`/api/tasks/${task.id}`,{revision:task.revision,title:'Завтра в 15:00',parseTitle:true,source:'Task послезавтра в 17:00',timezone:'UTC'},'PATCH')).data.task;
 assert.equal(task.due.time,'17:00');assert.equal(task.title,'Завтра в 15:00');
 task=(await app.request(`/api/tasks/${task.id}`,{revision:task.revision,title:'Встреча завтра в 15:00',parseTitle:true,clearSchedule:true},'PATCH')).data.task;
 assert.equal(task.due,null);assert.equal(task.title,'Встреча завтра в 15:00');
});

test('media attachments support authenticated previews, byte ranges, HEAD and safe download fallback', async t => {
  const app=await start(); t.after(()=>app.close());
  const login=await app.login(), cookie=login.response.headers.get('set-cookie').split(';')[0];
  const task=(await app.request('/api/tasks',{source:'Media'})).data.task;
  const base=`${app.base}/api/tasks/${task.id}/attachments`;
  for (const [name,type] of [['photo.PNG','image/png'],['clip.mp4','video/mp4'],['song.mp3','audio/mpeg'],['drawing.svg',null],['page.html',null],['constructor',null]]) {
    const upload=await fetch(base,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/octet-stream','X-File-Name':name},body:'0123456789'});
    assert.equal(upload.status,201);
    const {file}=await upload.json(), url=`${base}/${file.id}?preview=1`;
    assert.equal((await fetch(url)).status,401);
    const preview=await fetch(url,{headers:{Cookie:cookie}});
    assert.equal(preview.headers.get('content-type'),type || 'application/octet-stream');
    assert.match(preview.headers.get('content-disposition'),type ? /^inline;/ : /^attachment;/);
    assert.equal(preview.headers.get('x-content-type-options'),'nosniff');
    assert.match(preview.headers.get('content-security-policy'),/sandbox/);
    assert.equal(await preview.text(),'0123456789');
    const download=await fetch(`${base}/${file.id}`,{headers:{Cookie:cookie}});
    assert.match(download.headers.get('content-disposition'),/^attachment;/); await download.arrayBuffer();
    const listed=(await app.request(`/api/tasks/${task.id}/attachments`)).data.files.find(f=>f.id===file.id);
    assert.equal(listed.mediaType,type);
    if (!type) continue;
    for (const [range,status,body,contentRange] of [
      ['bytes=2-5',206,'2345','bytes 2-5/10'], ['bytes=7-',206,'789','bytes 7-9/10'],
      ['bytes=-3',206,'789','bytes 7-9/10'], ['bytes=8-100',206,'89','bytes 8-9/10'],
      ['bytes=10-',416,'','bytes */10'], ['bytes=5-2',416,'','bytes */10'],
      ['bytes=-0',416,'','bytes */10'], ['bytes=0-1,3-4',416,'','bytes */10'],
    ]) {
      const response=await fetch(url,{headers:{Cookie:cookie,Range:range}});
      assert.equal(response.status,status,range); assert.equal(response.headers.get('content-range'),contentRange);
      assert.equal(await response.text(),body);
    }
    const head=await fetch(url,{method:'HEAD',headers:{Cookie:cookie}});
    assert.equal(head.status,200); assert.equal(head.headers.get('content-length'),'10'); assert.equal(await head.text(),'');
  }
});


test('attachment cache revalidates without a body and cannot bypass login or deletion', async t => {
  const app=await start();t.after(()=>app.close());
  const login=await app.login(), cookie=login.response.headers.get('set-cookie').split(';')[0];
  const task=(await app.request('/api/tasks',{source:'Cached picture'})).data.task;
  const base=`/api/tasks/${task.id}/attachments`;
  const uploaded=await fetch(app.base+base,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/octet-stream','X-File-Name':'photo.png'},body:'picture'});
  const {file}=await uploaded.json();
  for(const suffix of ['', '?preview=1']) {
    const url=`${app.base}${base}/${file.id}${suffix}`;
    const first=await fetch(url,{headers:{Cookie:cookie}}), etag=first.headers.get('etag');
    assert.ok(etag);assert.equal(first.headers.get('cache-control'),'private, no-cache');assert.equal(first.headers.get('vary'),'Cookie');
    assert.equal(await first.text(),'picture');
    const cached=await fetch(url,{headers:{Cookie:cookie,'If-None-Match':etag}});
    assert.equal(cached.status,304);assert.equal(await cached.text(),'');
    const unauthorized=await fetch(url,{headers:{'If-None-Match':etag}});
    assert.equal(unauthorized.status,401);await unauthorized.text();
    const mismatch=await fetch(url,{headers:{Cookie:cookie,'If-None-Match':'"other"'}});
    assert.equal(mismatch.status,200);assert.equal(await mismatch.text(),'picture');
  }
  const url=`${app.base}${base}/${file.id}?preview=1`;
  const first=await fetch(url,{headers:{Cookie:cookie}}),etag=first.headers.get('etag');await first.text();
  await app.request(`${base}/${file.id}`,{},'DELETE');
  const deleted=await fetch(url,{headers:{Cookie:cookie,'If-None-Match':etag}});
  assert.equal(deleted.status,404);await deleted.text();
});
