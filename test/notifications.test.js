import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { Store } from '../server/store.js';
import { parseTask } from '../src/index.js';
import { NotificationWorker, notificationDefaults, validateConfig, publicConfig, makeReminder, digestMessage, sendNotification } from '../server/notifications.js';

const base = Date.parse('2030-05-10T08:00:00Z');
function config() {
  return validateConfig({ email: { enabled: true, host: 'smtp.example.com', from: 'tasks@example.com', to: 'user@example.com', user: 'user', password: 'test-only-secret' }, telegram: { enabled: true, token: '12345:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chatId: '123456' } }, notificationDefaults(), base);
}
function task(store, due = base + 3600000) {
  const local = DateTime.fromMillis(due, { zone: 'UTC' });
  return store.create({ title: 'Test task', due: { instant: local.toISO(), date: local.toISODate(), time: local.toFormat('HH:mm'), timezone: 'UTC', allDay: false } });
}
function add(store, t, body, now = base) {
  return store.mutate(t.id, t.revision, previous => ({ ...previous, reminders: [...(previous.reminders || []), makeReminder(body, previous, config(), now)] }));
}
const before = { kind: 'before', minutes: 30, channels: ['email', 'telegram'] };

test('channel configuration validates secrets, strips responses and keeps existing secrets on blank input', () => {
  const c = config(), visible = publicConfig(c);
  assert.equal(visible.email.password, undefined); assert.equal(visible.email.passwordSet, true);
  assert.equal(visible.telegram.token, undefined); assert.equal(visible.telegram.tokenSet, true);
  const updated = validateConfig({ email: { password: '' }, telegram: { token: '' } }, c);
  assert.equal(updated.email.password, c.email.password); assert.equal(updated.telegram.token, c.telegram.token);
  for (const patch of [{ email: { port: 0 } }, { email: { to: 'x\r\nBcc:y' } }, { telegram: { chatId: 'bad/chat' } }, { digest: { time: '25:00' } }, { digest: { timezone: 'No/Zone' } }, { digest: { channels: [] } }, { email: { enabled: 'yes' } }, JSON.parse('{"email":{"__proto__":{}}}')]) assert.throws(() => validateConfig(patch, c), { status: 400 });
  assert.throws(() => validateConfig({ digest: { enabled: true } }, notificationDefaults()), { status: 400 });
  assert.equal(validateConfig({ email: { enabled: false, password: null } }, c).email.password, '');
});

test('reminders require a future precise time, configured channels and valid local DST time', () => {
  const store = new Store(':memory:');
  try {
    const t = task(store);
    assert.throws(() => makeReminder(before, { ...t, due: { ...t.due, allDay: true } }, config(), base), { status: 400 });
    assert.throws(() => makeReminder(before, t, notificationDefaults(), base), { status: 400 });
    assert.throws(() => makeReminder({ ...before, minutes: -1 }, t, config(), base), { status: 400 });
    assert.throws(() => makeReminder({ ...before, minutes: 61 }, t, config(), base), { status: 400 });
    assert.throws(() => makeReminder({ ...before, channels: ['email', 'email'] }, t, config(), base), { status: 400 });
    assert.throws(() => makeReminder({ kind: 'absolute', local: '2030-03-31T02:30', timezone: 'Europe/Berlin', channels: ['email'] }, t, config(), 0), { status: 400 });
    assert.throws(() => makeReminder({ kind: 'absolute', local: '2030-10-27T02:30', timezone: 'Europe/Berlin', channels: ['email'] }, t, config(), 0), { status: 400 });
    const r = makeReminder({ kind: 'absolute', local: '2030-05-11T09:00', timezone: 'Europe/Moscow', channels: ['email'] }, { ...t, due: null }, config(), base);
    assert.equal(r.at, '2030-05-11T06:00:00.000Z');
  } finally { store.close(); }
});

test('outbox retries only the failed channel, survives restart and deduplicates deliveries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendoist-notifications-')), file = join(dir, 'db.sqlite');
  let store = new Store(file), now = base, attempts = [];
  try {
    store.saveNotificationConfig(config()); add(store, task(store), before);
    let worker = new NotificationWorker(store, { now: () => now, send: async channel => { attempts.push(channel); if (channel === 'telegram') throw Error('secret provider error'); } });
    await worker.tick(); assert.deepEqual(attempts, []);
    now += 30 * 60000; await Promise.all([worker.tick(), worker.tick()]);
    assert.deepEqual(attempts.sort(), ['email', 'telegram']);
    assert.doesNotMatch(JSON.stringify(store.notificationStatus()), /secret provider/);
    store.close(); store = new Store(file);
    worker = new NotificationWorker(store, { now: () => now, send: async channel => { attempts.push(channel); } });
    await worker.tick(); assert.equal(attempts.length, 2);
    now += 60000; await worker.tick(); await worker.tick();
    assert.deepEqual(attempts, ['email', 'telegram', 'telegram']);
    assert.ok(store.notificationStatus().every(r => r.status === 'sent'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('completed, moved, removed and deleted tasks do not deliver stale queued reminders', async () => {
  for (const action of ['complete', 'move', 'remove', 'delete']) {
    const store = new Store(':memory:'); let now = base, count = 0;
    try {
      store.saveNotificationConfig(config()); let t = add(store, task(store), { ...before, channels: ['email'] });
      const worker = new NotificationWorker(store, { now: () => now, send: async () => { count++; throw Error(); } });
      now += 30 * 60000; await worker.tick(); assert.equal(count, 1);
      if (action === 'complete') store.complete(t.id, t.revision);
      if (action === 'move') store.mutate(t.id, t.revision, old => ({ ...old, due: { ...old.due, instant: '2030-05-11T09:00:00Z' } }));
      if (action === 'remove') store.mutate(t.id, t.revision, old => ({ ...old, reminders: [] }));
      if (action === 'delete') store.mutate(t.id, t.revision, () => null);
      now += 60000; await worker.tick(); assert.equal(count, 1, action);
    } finally { store.close(); }
  }
});

test('relative reminders follow recurring tasks; absolute reminders fire only once', async () => {
  const store = new Store(':memory:'); let now = base; const sent = [];
  try {
    store.saveNotificationConfig(config()); let t = store.create(parseTask('Task every day at 9am', { now: new Date(base), timezone: 'UTC' }));
    t = add(store, t, { ...before, channels: ['email'] });
    t = add(store, t, { kind: 'absolute', local: '2030-05-10T08:30', timezone: 'UTC', channels: ['email'] });
    const worker = new NotificationWorker(store, { now: () => now, send: async (_c, _cfg, _m, key) => { sent.push(key); } });
    now += 30 * 60000; await worker.tick(); assert.equal(sent.length, 2);
    t = store.complete(t.id, t.revision);
    assert.equal(t.due.date, '2030-05-11');
    now += 86400000; await worker.tick(); assert.equal(sent.length, 3);
    assert.equal(sent.filter(key => key.includes(t.reminders[1].id)).length, 1);
  } finally { store.close(); }
});

test('morning/evening digests respect timezone, target date, restart deduplication and activation time', async () => {
  for (const mode of ['morning', 'evening']) {
    const store = new Store(':memory:'); let now = Date.parse('2030-05-10T04:59:00Z'); const messages = [];
    try {
      const c = config(); c.digest = { enabled: true, mode, time: '08:00', timezone: 'Europe/Moscow', channels: ['telegram'], updatedAt: now };
      store.saveNotificationConfig(c);
      const worker = new NotificationWorker(store, { now: () => now, send: async (_ch, _cfg, message) => messages.push(message) });
      await worker.tick(); assert.equal(messages.length, 0);
      now += 60000; await worker.tick(); await worker.tick();
      assert.equal(messages.length, 1); assert.match(messages[0].subject, mode === 'morning' ? /2030-05-10/ : /2030-05-11/);
      await new NotificationWorker(store, { now: () => now, send: async () => messages.push('duplicate') }).tick(); assert.equal(messages.length, 1);
      now += 86400000; c.digest.updatedAt = now + 1; store.saveNotificationConfig(c); await worker.tick(); assert.equal(messages.length, 1);
    } finally { store.close(); }
  }
});

test('digest includes due, overdue and future calendar occurrences but excludes completed and unscheduled tasks', () => {
  const due = (title, date, allDay = true, instant = null) => ({ title, due: { date, allDay, instant, timezone: 'UTC', time: allDay ? null : '22:30' } });
  const repeated = parseTask('Повтор каждый день в 9', { now: new Date('2030-05-09T00:00:00Z'), timezone: 'Europe/Moscow' });
  const message = digestMessage([due('Сегодня', '2030-05-10'), due('Просрочено', '2030-05-09'), due('По местному времени', '2030-05-09', false, '2030-05-09T22:30:00Z'), { ...due('Скрыто', '2030-05-10'), completedAt: 'done' }, { title: 'Без срока' }, repeated], '2030-05-10', 'Europe/Moscow');
  assert.match(message.text, /Сегодня/); assert.match(message.text, /Просрочено/); assert.match(message.text, /По местному времени/); assert.match(message.text, /Повтор/); assert.doesNotMatch(message.text, /Скрыто|Без срока/);
});

test('Telegram transport sends plain text and checks provider errors; SMTP uses required TLS and stable message IDs', async () => {
  const c = config(), message = { subject: 'Test', text: '<b>literal task</b>' }; let payload, options, mail;
  await sendNotification('telegram', c, message, 'key', { fetcher: async (url, init) => { assert.match(url, /^https:\/\/api.telegram.org\/bot/); payload = JSON.parse(init.body); return { ok: true, json: async () => ({ ok: true }) }; } });
  assert.match(payload.text, /<b>literal task<\/b>/); assert.equal(payload.parse_mode, undefined); assert.equal(payload.chat_id, c.telegram.chatId);
  await assert.rejects(sendNotification('telegram', c, message, 'key', { fetcher: async () => ({ ok: false, json: async () => ({ ok: false }) }) }));
  await sendNotification('email', c, message, 'key', { mailer: { createTransport: opts => { options = opts; return { sendMail: async msg => { mail = msg; }, close() {} }; } } });
  assert.equal(options.requireTLS, true); assert.equal(options.debug, false); assert.equal(mail.text, message.text); assert.match(mail.messageId, /@opendoist.local>$/);
});

test('outbox recovers expired leases, rejects parallel claims and expires old retries', async () => {
  const store = new Store(':memory:'); let now = base, release, calls = 0;
  try {
    store.saveNotificationConfig(config()); add(store, task(store), { ...before, channels: ['email'] });
    const worker = new NotificationWorker(store, { now: () => now, send: async () => { calls++; await new Promise(resolve => { release = resolve; }); } });
    now += 30 * 60000; const first = worker.tick();
    await new NotificationWorker(store, { now: () => now, send: async () => { calls++; } }).tick();
    assert.equal(calls, 1); release(); await first;
    // Simulate a process interrupted after claiming, before sending.
    store.db.prepare("UPDATE notification_outbox SET status='pending',lease_until=?").run(now + 120000);
    const restarted = new NotificationWorker(store, { now: () => now, send: async () => { calls++; throw Error(); } });
    await restarted.tick(); assert.equal(calls, 1);
    now += 120001; await restarted.tick(); assert.equal(calls, 2);
    now += 86400000; await restarted.tick(); assert.equal(calls, 2);
    assert.equal(store.notificationStatus()[0].status, 'cancelled');
  } finally { store.close(); }
});

test('digest is cancelled when disabled while a delivery retry is pending', async () => {
  const store = new Store(':memory:'); let now = Date.parse('2030-05-10T05:00:00Z'), calls = 0;
  try {
    const c = config(); c.digest = { enabled: true, mode: 'morning', time: '08:00', timezone: 'Europe/Moscow', channels: ['telegram'], updatedAt: 0 };
    store.saveNotificationConfig(c);
    const worker = new NotificationWorker(store, { now: () => now, send: async () => { calls++; throw Error(); } });
    await worker.tick(); assert.equal(calls, 1);
    store.saveNotificationConfig(validateConfig({ digest: { enabled: false } }, c, now));
    now += 60000; await worker.tick(); assert.equal(calls, 1);
    assert.equal(store.notificationStatus()[0].status, 'cancelled');
  } finally { store.close(); }
});

test('a digest in a DST fallback hour is delivered only once', async () => {
  const store = new Store(':memory:'); let now = Date.parse('2030-10-27T00:30:00Z'), calls = 0;
  try {
    const c = config(); c.digest = { enabled: true, mode: 'morning', time: '02:30', timezone: 'Europe/Berlin', channels: ['telegram'], updatedAt: 0 };
    store.saveNotificationConfig(c);
    const worker = new NotificationWorker(store, { now: () => now, send: async () => { calls++; } });
    await worker.tick(); now += 3600000; await worker.tick(); await worker.tick(); assert.equal(calls, 1);
  } finally { store.close(); }
});

test('rescheduling a failed digest sends at the new time without resending a successful digest', async () => {
  const store = new Store(':memory:'); let now = Date.parse('2030-05-10T05:00:00Z'), calls = 0, fail = true;
  try {
    const c = config(); c.digest = { enabled: true, mode: 'morning', time: '08:00', timezone: 'Europe/Moscow', channels: ['telegram'], updatedAt: 0 };
    store.saveNotificationConfig(c);
    const worker = new NotificationWorker(store, { now: () => now, send: async () => { calls++; if (fail) throw Error(); } });
    await worker.tick(); assert.equal(calls, 1);
    now += 60000; store.saveNotificationConfig(validateConfig({ digest: { time: '08:05' } }, c, now));
    await worker.tick(); assert.equal(calls, 1); fail = false;
    now += 4 * 60000; await worker.tick(); assert.equal(calls, 2);
    store.saveNotificationConfig(validateConfig({ digest: { time: '08:10' } }, store.notificationConfig(), now));
    now += 5 * 60000; await worker.tick(); assert.equal(calls, 2);
  } finally { store.close(); }
});

test('both digests send today in the morning and tomorrow in the evening without duplicates',async()=>{
 const store=new Store(':memory:');let now=Date.parse('2030-05-10T08:00:00Z');const messages=[];
 const c=validateConfig({digest:{enabled:true,mode:'both',time:'08:00',eveningTime:'20:00',timezone:'UTC',channels:['telegram']}},config(),now-86400000);
 store.saveNotificationConfig(c);
 const worker=new NotificationWorker(store,{now:()=>now,send:async(channel,message)=>messages.push(message)});
 try{
  await worker.tick();await worker.tick();assert.equal(messages.length,1);
  now=Date.parse('2030-05-10T20:00:00Z');await worker.tick();await worker.tick();assert.equal(messages.length,2);
  const events=store.db.prepare('SELECT event FROM notification_outbox ORDER BY scheduled').all().map(r=>JSON.parse(r.event));
  assert.deepEqual(events.map(e=>[e.mode,e.date]),[['morning','2030-05-10'],['evening','2030-05-11']]);
  assert.throws(()=>validateConfig({digest:{eveningTime:'25:00'}},c));
 }finally{await worker.stop();store.close();}
});
