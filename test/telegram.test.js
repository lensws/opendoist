import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { TelegramInbox } from '../server/telegram.js';
import { validateConfig, notificationDefaults } from '../server/notifications.js';
const now = Date.parse('2030-05-10T08:00:00Z');
const config = () => validateConfig({ telegram: { enabled: true, token: '12345:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chatId: '123456', acceptTasks: true } }, notificationDefaults(), now);
const message = (id, text, extra = {}) => ({ update_id: id, message: { message_id: id, text, date: now / 1000 + 1, chat: { id: 123456, type: 'private' }, from: { id: 123456 }, ...extra } });
function mock(updates, replies, failReply = false) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/getUpdates')) return { ok: true, json: async () => ({ ok: true, result: updates.filter(u => u.update_id >= body.offset) }) };
    assert.ok(url.endsWith('/sendMessage')); replies.push(body.text);
    return { ok: !failReply, status: failReply ? 500 : 200, json: async () => ({ ok: !failReply, result: {} }) };
  };
}
test('Telegram creates a parsed task only for the configured private user and ignores old messages', async () => {
  const store = new Store(':memory:'), replies = [];
  try {
    store.saveNotificationConfig(config());
    const updates = [message(1, 'Old', { date: now / 1000 - 1 }), message(2, 'Other', { chat: { id: 777, type: 'private' }, from: { id: 777 } }), message(3, 'Group', { chat: { id: 123456, type: 'group' } }), message(4, 'Bot', { from: { id: 123456, is_bot: true } }), message(5, 'Купить молоко завтра в 18')];
    const inbox = new TelegramInbox(store, { fetcher: mock(updates, replies), now: () => now + 2000 });
    await Promise.all([inbox.tick(), inbox.tick()]); await inbox.tick();
    assert.equal(store.list().length, 1); assert.equal(store.list()[0].title, 'Купить молоко'); assert.equal(store.list()[0].due.date, '2030-05-11'); assert.equal(store.list()[0].due.time, '18:00'); assert.equal(replies.length, 1);
  } finally { store.close(); }
});
test('Telegram handles projects, commands and ambiguous dates without creating malformed tasks', async () => {
  const store = new Store(':memory:'), replies = [];
  try {
    store.saveNotificationConfig(config()); const project = store.saveEntity('project', { name: 'Мой проект', iconType: 'emoji', color: '#3478cb', emoji: '🧑‍💻' });
    const updates = [message(1, '/help'), message(2, '/projects'), message(3, '#"Мой проект" Полив каждую пятницу в 10'), message(4, '#Нет Задача завтра'), message(5, 'every 0 days'), message(6, '/add Read a book tomorrow at 7pm')];
    await new TelegramInbox(store, { fetcher: mock(updates, replies), now: () => now + 2000 }).tick();
    assert.equal(store.list().length, 2); const recurring = store.list().find(t => t.title === 'Полив'); assert.equal(recurring.projectId, project.id); assert.ok(recurring.recurrence); assert.match(replies[3], /не найден/); assert.match(replies[4], /не добавлена/);
  } finally { store.close(); }
});
test('Telegram cursor and pending confirmation survive restart without duplicating the task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendoist-bot-')), file = join(dir, 'data.sqlite'); let store = new Store(file), clock = now + 2000; const replies = [], updates = [message(1, 'Task tomorrow')];
  try {
    store.saveNotificationConfig(config()); await new TelegramInbox(store, { fetcher: mock(updates, replies, true), now: () => clock }).tick(); assert.equal(store.list().length, 1);
    store.close(); store = new Store(file); clock += 60000;
    await new TelegramInbox(store, { fetcher: mock(updates, replies), now: () => clock }).tick();
    assert.equal(store.list().length, 1); assert.equal(replies.length, 2); assert.equal(store.db.prepare('SELECT sent FROM telegram_replies').get().sent, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('disabled inbox does not poll and webhook conflicts do not delete the webhook or expose credentials', async () => {
  const store = new Store(':memory:'); let calls = 0;
  try {
    const inbox = new TelegramInbox(store, { fetcher: async () => { calls++; return { ok: false, status: 409, json: async () => ({ ok: false }) }; } });
    await inbox.tick(); assert.equal(calls, 0);
    store.saveNotificationConfig(config()); await inbox.tick(); assert.equal(calls, 1); assert.match(inbox.status.error, /webhook/); assert.doesNotMatch(inbox.status.error, /aaaa/);
    assert.throws(() => validateConfig({ telegram: { chatId: '-123456' } }, config()), { status: 400 });
  } finally { store.close(); }
});
