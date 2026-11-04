import { randomUUID, createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import nodemailer from 'nodemailer';
import { AppError } from './store.js';
import { occurrences } from '../src/index.js';

export const notificationDefaults = () => ({
  email: { enabled: false, host: '', port: 587, secure: false, user: '', password: '', from: '', to: '' },
  telegram: { enabled: false, token: '', chatId: '', acceptTasks: false, receiveSince: 0 },
  digest: { enabled: false, mode: 'morning', time: '08:00', eveningTime:'20:00', timezone: 'Europe/Moscow', channels: ['email'], updatedAt: 0 },
});
const bad = message => { throw new AppError(400, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const channelsValid = value => Array.isArray(value) && value.length > 0 && value.length <= 2 && new Set(value).size === value.length && value.every(c => ['email', 'telegram'].includes(c));
const zoneValid = zone => typeof zone === 'string' && zone.length <= 100 && DateTime.now().setZone(zone).isValid;
export function publicConfig(config) {
  const copy = structuredClone(config);
  copy.email.passwordSet = !!copy.email.password; delete copy.email.password;
  copy.telegram.tokenSet = !!copy.telegram.token; delete copy.telegram.token;
  return copy;
}
export function validateConfig(patch, previous, now = Date.now()) {
  if (!object(patch) || Object.keys(patch).some(k => !['email', 'telegram', 'digest'].includes(k))) bad('Некорректные настройки уведомлений');
  previous = { ...previous, digest:{...notificationDefaults().digest,...previous.digest}, telegram: { ...notificationDefaults().telegram, ...previous.telegram } };
  const next = structuredClone(previous);
  for (const section of Object.keys(patch)) {
    if (!object(patch[section])) bad('Некорректные настройки уведомлений');
    for (const [key, value] of Object.entries(patch[section])) {
      if (!Object.hasOwn(next[section], key) || ['updatedAt', 'receiveSince'].includes(key)) bad('Неизвестная настройка уведомлений');
      // Empty password/token means keep the saved secret. null explicitly removes it.
      if (['password', 'token'].includes(key) && value === '') continue;
      next[section][key] = ['password', 'token'].includes(key) && value === null ? '' : value;
    }
  }
  for (const section of ['email', 'telegram', 'digest']) if (typeof next[section].enabled !== 'boolean') bad('Некорректное состояние канала');
  const e = next.email, t = next.telegram, d = next.digest;
  for (const v of [e.host, e.user, e.password, e.from, e.to, t.token, t.chatId]) if (typeof v !== 'string' || v.length > 1000 || /[\r\n]/.test(v)) bad('Проверьте параметры подключения');
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535 || typeof e.secure !== 'boolean') bad('Проверьте порт и шифрование SMTP');
  const email = value => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value);
  if (e.enabled && (!/^[a-z0-9.-]+$/i.test(e.host) || !email(e.from) || !email(e.to))) bad('Для email укажите SMTP-сервер, адрес отправителя и получателя');
  if (e.enabled && e.user && !e.password) bad('Укажите пароль SMTP');
  if (t.enabled && (!/^\d+:[\w-]{20,}$/.test(t.token) || !/^(?:-?\d+|@[a-z0-9_]{5,})$/i.test(t.chatId))) bad('Для Telegram укажите токен бота и Chat ID');
  if (!['morning', 'evening', 'both'].includes(d.mode) || typeof d.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time) || !zoneValid(d.timezone) || !channelsValid(d.channels)) bad('Проверьте время, часовой пояс и каналы сводки');
  if (typeof d.eveningTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.eveningTime)) bad('Проверьте время вечерней сводки');
  if (d.enabled && d.channels.some(c => !next[c].enabled)) bad('Сначала включите выбранные каналы сводки');
  if (!t.enabled) t.acceptTasks = false;
  if (typeof t.acceptTasks !== 'boolean' || (t.acceptTasks && (!t.enabled || !/^[1-9]\d*$/.test(t.chatId)))) bad('Создание задач доступно только в подключённом личном чате: укажите положительный числовой Chat ID');
  if (t.acceptTasks && (!previous.telegram.acceptTasks || previous.telegram.token !== t.token || previous.telegram.chatId !== t.chatId)) t.receiveSince = Math.floor(now / 1000) * 1000;
  const comparable = c => JSON.stringify({ ...c.digest, updatedAt: 0 });
  if (comparable(next) !== comparable(previous)) next.digest.updatedAt = now;
  return next;
}
export function makeReminder(body, task, config, now = Date.now()) {
  if (task.completedAt) bad('Задача уже выполнена');
  if ((task.reminders || []).length >= 10) bad('Можно добавить до 10 напоминаний');
  if (!channelsValid(body.channels) || body.channels.some(c => !config[c].enabled)) bad('Выберите подключённый канал уведомлений в настройках');
  const reminder = { id: randomUUID(), kind: body.kind, channels: body.channels, createdAt: now };
  if (body.kind === 'before') {
    if (!task.due?.instant || task.due.allDay) bad('Для напоминания до задачи задайте ей дату и время');
    if (!Number.isInteger(body.minutes) || body.minutes < 0 || body.minutes > 525600) bad('Укажите от 0 до 525600 минут до задачи');
    reminder.minutes = body.minutes;
    if (Date.parse(task.due.instant) - body.minutes * 60000 <= now) bad('Время напоминания уже прошло');
  } else if (body.kind === 'absolute') {
    if (!zoneValid(body.timezone) || typeof body.local !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(body.local)) bad('Укажите дату, время и часовой пояс');
    const date = DateTime.fromISO(body.local, { zone: body.timezone });
    if (!date.isValid || date.toFormat("yyyy-MM-dd'T'HH:mm") !== body.local) bad('Такого местного времени не существует');
    if (date.getPossibleOffsets().length > 1) bad('Это время повторяется при переводе часов. Выберите другое время или часовой пояс UTC');
    if (date.toMillis() <= now) bad('Время напоминания уже прошло');
    reminder.at = date.toUTC().toISO(); reminder.timezone = body.timezone;
  } else bad('Выберите тип напоминания');
  return reminder;
}
export function reminderTime(reminder, task) {
  return reminder.kind === 'absolute' ? Date.parse(reminder.at) : task.due?.instant && !task.due.allDay ? Date.parse(task.due.instant) - reminder.minutes * 60000 : NaN;
}
function relativeDate(date, zone, now) {
  const today = DateTime.fromMillis(now, { zone }).startOf('day');
  if (date === today.toISODate()) return 'сегодня';
  if (date === today.plus({ days: 1 }).toISODate()) return 'завтра';
  if (date === today.minus({ days: 1 }).toISODate()) return 'вчера';
  return DateTime.fromISO(date, { zone }).setLocale('ru').toFormat('d MMMM yyyy');
}
export function dueText(task, now = Date.now()) {
  if (!task.due) return 'Без срока';
  return `${relativeDate(task.due.date, task.due.timezone, now)}${!task.due.allDay && task.due.time ? ` в ${task.due.time}` : ''}`;
}
export function digestMessage(tasks, date, zone, now = Date.now()) {
  const due = [], overdue = [];
  for (const task of tasks.filter(t => !t.completedAt)) {
    if (!task.due) continue;
    // All-day dates keep their calendar day; timed tasks use the digest timezone.
    const localDate = task.due.allDay ? task.due.date : DateTime.fromISO(task.due.instant).setZone(zone).toISODate();
    if (localDate === date) due.push(task);
    else {
      if (localDate < date) overdue.push(task);
      if (task.recurrence?.mode === 'calendar') {
        const start = DateTime.fromISO(date, { zone: task.due.allDay ? task.due.timezone : zone }).startOf('day');
        const next = occurrences(task, { after: start.minus({ milliseconds: 1 }).toISO(), count: 1 })[0];
        if (next && (next.allDay ? next.date : DateTime.fromISO(next.instant).setZone(zone).toISODate()) === date) due.push({ ...task, due: next });
      }
    }
  }
  const lines = [];
  const localTime = task => task.due.allDay ? '' : DateTime.fromISO(task.due.instant).setZone(zone).toFormat('HH:mm');
  due.sort((a, b) => localTime(a).localeCompare(localTime(b)));
  const line = task => `• ${task.title}${localTime(task) ? ` в ${localTime(task)}` : ''}`;
  lines.push(due.length ? `На этот день: ${due.length}` : 'На этот день задач нет.', ...due.map(line));
  if (overdue.length) lines.push('', `Просроченные: ${overdue.length}`, ...overdue.map(task => {
    const localDate = task.due.allDay ? task.due.date : DateTime.fromISO(task.due.instant).setZone(zone).toISODate();
    return `• ${task.title} — ${relativeDate(localDate, zone, now)}${localTime(task) ? ` в ${localTime(task)}` : ''}`;
  }));
  return { subject: `OpenDoist · План на ${relativeDate(date, zone, now)}`, text: lines.join('\n') };
}
export async function sendNotification(channel, config, message, key, { fetcher = fetch, mailer = nodemailer } = {}) {
  if (channel === 'telegram') {
    // No parse_mode: task text must never be interpreted as Telegram markup.
    const fullText = `${message.subject}\n\n${message.text}`;
    const text = fullText.length > 4000 ? `${fullText.slice(0, 3850)}\n… Полный список дел — в OpenDoist.` : fullText;
    const response = await fetcher(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: config.telegram.chatId, text, link_preview_options: { is_disabled: true } }), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error('Telegram delivery failed');
  } else {
    const e = config.email;
    const transport = mailer.createTransport({ host: e.host, port: e.port, secure: e.secure, requireTLS: !e.secure, auth: e.user ? { user: e.user, pass: e.password } : undefined, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true });
    try {
      await transport.sendMail({ from: e.from, to: e.to, subject: message.subject, text: message.text, messageId: `<${createHash('sha256').update(key).digest('hex')}@opendoist.local>` });
    } finally { transport.close(); }
  }
}

// One persistent outbox per installation. A lease recovers interrupted attempts after restart.
export class NotificationWorker {
  constructor(store, { send = sendNotification, now = Date.now, publicUrl = '' } = {}) {
    this.store = store; this.send = send; this.now = now; this.publicUrl = publicUrl; this.running = null;
  }
  config() { const saved = this.store.notificationConfig() || notificationDefaults(); return { ...saved, digest:{...notificationDefaults().digest,...saved.digest}, telegram: { ...notificationDefaults().telegram, ...saved.telegram } }; }
  start() { this.timer = setInterval(() => this.tick().catch(() => console.error('Notification scheduler failed')), 15000); this.timer.unref(); this.tick().catch(() => console.error('Notification scheduler failed')); }
  async stop() { clearInterval(this.timer); await this.running; }
  tick() {
    if (this.running) return this.running;
    this.running = this.process().finally(() => { this.running = null; }); return this.running;
  }
  enqueue(key, channel, taskId, event, scheduled, expires) {
    this.store.db.prepare(`INSERT INTO notification_outbox (key,channel,task_id,event,scheduled,expires,next_attempt) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET event=excluded.event,scheduled=excluded.scheduled,expires=excluded.expires,
        next_attempt=excluded.next_attempt,status='pending',attempts=0,lease_until=0,last_error=NULL
      WHERE notification_outbox.status!='sent' AND json_extract(excluded.event,'$.type')='digest'
        AND json_extract(notification_outbox.event,'$.updatedAt')!=json_extract(excluded.event,'$.updatedAt')`).run(key, channel, taskId, JSON.stringify(event), scheduled, expires, scheduled);
  }
  async process() {
    const now = this.now(), day = 86400000, config = this.config(), db = this.store.db;
    for (const task of this.store.list().filter(t => !t.completedAt)) for (const reminder of task.reminders || []) {
      const at = reminderTime(reminder, task);
      if (!Number.isFinite(at) || at > now || at < now - day || at < reminder.createdAt) continue;
      for (const channel of reminder.channels.filter(c => config[c].enabled)) this.enqueue(`reminder:${reminder.id}:${at}:${channel}`, channel, task.id, { type: 'reminder', reminderId: reminder.id, at }, at, at + day);
    }
    const d = config.digest;
    if (d.enabled) for(const mode of d.mode==='both' ? ['morning','evening'] : [d.mode]) {
      const time=d.mode==='both' && mode==='evening' ? d.eveningTime : d.time;
      const local = DateTime.fromMillis(now, { zone: d.timezone });
      const sendAt = DateTime.fromISO(`${local.toISODate()}T${time}`, { zone: d.timezone }).toMillis();
      // Up to three hours of catch-up, but never backfill a newly enabled digest.
      if (now >= sendAt && now - sendAt < 3 * 3600000 && sendAt >= d.updatedAt) {
        const date = (mode === 'evening' ? local.plus({ days: 1 }) : local).toISODate();
        for (const channel of d.channels.filter(c => config[c].enabled)) this.enqueue(`digest:${date}:${mode}:${channel}`, channel, null, { type: 'digest', date, mode, timezone: d.timezone, updatedAt: d.updatedAt }, sendAt, sendAt + 3 * 3600000);
      }
    }
    const rows = db.prepare("SELECT * FROM notification_outbox WHERE status='pending' AND next_attempt<=? AND lease_until<=? ORDER BY scheduled LIMIT 25").all(now, now);
    for (const row of rows) {
      const attemptTime = this.now();
      if (!db.prepare("UPDATE notification_outbox SET lease_until=? WHERE key=? AND status='pending' AND lease_until<=?").run(attemptTime + 120000, row.key, attemptTime).changes) continue;
      const current = this.config(), event = JSON.parse(row.event);
      let message, valid = current[row.channel].enabled && row.expires > attemptTime;
      if (event.type === 'reminder') {
        let task; try { task = this.store.get(row.task_id); } catch { valid = false; }
        const reminder = task?.reminders?.find(r => r.id === event.reminderId);
        valid = valid && task && !task.completedAt && reminder && reminder.channels.includes(row.channel) && reminderTime(reminder, task) === event.at;
        if (valid) message = { subject: 'OpenDoist · Напоминание', text: `${task.title}\nСрок: ${dueText(task, attemptTime)}` };
      } else {
        valid = valid && current.digest.enabled && current.digest.channels.includes(row.channel) && current.digest.updatedAt === event.updatedAt;
        if (valid) message = digestMessage(this.store.list(), event.date, event.timezone, attemptTime);
      }
      if (!valid) { db.prepare("UPDATE notification_outbox SET status='cancelled',lease_until=0 WHERE key=?").run(row.key); continue; }
      if (this.publicUrl) message.text += `\n\n${this.publicUrl}`;
      try {
        await this.send(row.channel, current, message, row.key);
        db.prepare("UPDATE notification_outbox SET status='sent',sent_at=?,lease_until=0,last_error=NULL WHERE key=?").run(this.now(), row.key);
      } catch {
        const attempts = row.attempts + 1;
        // Never persist provider responses: they may contain credentials or message text.
        db.prepare('UPDATE notification_outbox SET status=?,attempts=?,next_attempt=?,lease_until=0,last_error=? WHERE key=?').run(attempts >= 8 ? 'failed' : 'pending', attempts, this.now() + Math.min(3600000, 60000 * 2 ** (attempts - 1)), 'Не удалось доставить. Проверьте подключение канала.', row.key);
      }
    }
  }
}
