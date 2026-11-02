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
    const saved = { theme: 'dark', accent: '#167eaa', timezone: 'Asia/Tokyo', language: 'en' };
    assert.deepEqual((await app.request('/api/settings', saved, 'PATCH')).data.settings, saved);
    for (const patch of [{ theme: 'invalid' }, { accent: 'red' }, { accent: null }, { timezone: 'No/Zone' }, { timezone: null }, { language: 'xx' }, { unknown: true }]) {
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
