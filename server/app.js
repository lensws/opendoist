import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { parseTask, occurrences } from '../src/index.js';
import { validateImport, IMPORT_LIMIT } from './import.js';
import { Store, AppError } from './store.js';
import { TelegramInbox } from './telegram.js';
import { NotificationWorker, publicConfig, validateConfig, makeReminder } from './notifications.js';

const assets = new Map(['index.html', 'app.js', 'style.css', 'icon.svg', 'appearance.js', 'notifications.js', 'transfer.js', 'projects.js', 'emoji-picker.js', 'emoji-search.js', 'emojis.json', 'emojis-LICENSE.txt'].map(name => [name, readFileSync(new URL(`../public/${name}`, import.meta.url))]));
const mime = { json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const SESSION_AGE = 7 * 86400 * 1000;
async function readJSON(req, limit = 16384) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, 'Ожидается JSON');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new AppError(413, 'Слишком большой запрос'); chunks.push(chunk); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || Array.isArray(body) || typeof body !== 'object') throw Error(); return body; }
  catch { throw new AppError(400, 'Некорректный JSON'); }
}
function text(value, max = 500) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, `Введите текст длиной до ${max} символов`); return value.trim(); }
function parse(body) {
  const source = text(body.source);
  const reference = body.reference ? new Date(body.reference) : new Date();
  if (!Number.isFinite(+reference) || Math.abs(Date.now() - reference) > 15 * 60 * 1000) throw new AppError(400, 'Предпросмотр устарел. Проверьте дату ещё раз.');
  let parsed;
  try { parsed = parseTask(source, { now: reference, timezone: body.timezone || 'Europe/Moscow', language: body.language || 'auto' }); }
  catch { throw new AppError(400, 'Проверьте язык, часовой пояс и дату'); }
  return { parsed, reference: reference.toISOString() };
}
function saveable(parsed) {
  if (parsed.status === 'needs_review') throw new AppError(422, 'Не удалось однозначно распознать дату. Измените формулировку.');
  if (!parsed.title.trim()) throw new AppError(422, 'Добавьте название задачи перед датой');
  return parsed;
}
export function createApp({ password, database = './data/opendoist.sqlite', publicUrl, secureCookie = false, notificationSender } = {}) {
  if (typeof password !== 'string' || password.length < 12 || password === 'change-this-before-use') throw new Error('Set OPENDOIST_PASSWORD to a unique password of at least 12 characters');
  const allowedOrigin = publicUrl ? new URL(publicUrl).origin : null;
  if (allowedOrigin?.startsWith('https:')) secureCookie = true;
  const store = new Store(database);
  const notifications = new NotificationWorker(store, { publicUrl: allowedOrigin || '', ...(notificationSender ? { send: notificationSender } : {}) });
  const telegram = new TelegramInbox(store);
  let lastTest = 0;
  const salt = randomBytes(32), expected = scryptSync(password, salt, 32);
  const sessionHash = token => createHmac('sha256', password).update(token).digest('hex');
  let attempts = []; // Global limiter: works behind reverse proxies without trusting forwarded IPs.
  const cookie = (token, maxAge) => `opendoist_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const server = createServer(async (req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" };
    const send = (status, data, extra = {}) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(data)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const method = req.method;
      if (method === 'GET' && path === '/healthz') return send(200, { ok: true });
      if (method === 'GET' && !path.startsWith('/api/')) {
        const name = path === '/' ? 'index.html' : path.slice(1);
        if (!assets.has(name)) return send(404, { error: 'Не найдено' });
        res.writeHead(200, { ...headers, 'Content-Type': mime[name.split('.').pop()] }); return res.end(assets.get(name));
      }
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return send(405, { error: 'Метод не поддерживается' });
      if (method !== 'GET') {
        const expectedOrigin = allowedOrigin || `http://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== expectedOrigin) throw new AppError(403, 'Недопустимый источник запроса');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'Недопустимый источник запроса');
      }
      if (path === '/api/login' && method === 'POST') {
        const body = await readJSON(req);
        attempts = attempts.filter(t => t > Date.now() - 60000);
        if (attempts.length >= 10) throw new AppError(429, 'Слишком много попыток. Попробуйте через минуту.');
        attempts.push(Date.now());
        const supplied = typeof body.password === 'string' && body.password.length <= 1024 ? body.password : '';
        if (!timingSafeEqual(scryptSync(supplied, salt, 32), expected)) throw new AppError(401, 'Неверный пароль');
        const token = randomBytes(32).toString('hex');
        store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
        store.db.prepare('INSERT INTO sessions VALUES (?,?)').run(sessionHash(token), Date.now() + SESSION_AGE);
        return send(200, { ok: true }, { 'Set-Cookie': cookie(token, SESSION_AGE / 1000) });
      }
      const token = /(?:^|;\s*)opendoist_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session = token && store.db.prepare('SELECT expires FROM sessions WHERE hash=?').get(sessionHash(token));
      if (!session || session.expires < Date.now()) throw new AppError(401, 'Войдите в приложение');
      if (path === '/api/session' && method === 'GET') return send(200, { ok: true });
      if (path === '/api/logout' && method === 'POST') {
        store.db.prepare('DELETE FROM sessions WHERE hash=?').run(sessionHash(token));
        return send(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
      }
      if (path === '/api/notifications' && method === 'GET') return send(200, { config: publicConfig(notifications.config()), deliveries: store.notificationStatus(), telegram: telegram.status });
      if (path === '/api/notifications' && method === 'PATCH') {
        const config = validateConfig(await readJSON(req), notifications.config());
        store.saveNotificationConfig(config);
        return send(200, { config: publicConfig(config) });
      }
      if (path === '/api/notifications/test' && method === 'POST') {
        const { channel } = await readJSON(req), config = notifications.config();
        if (!['email', 'telegram'].includes(channel) || !config[channel].enabled) throw new AppError(400, 'Сначала сохраните и включите канал');
        if (Date.now() - lastTest < 10000) throw new AppError(429, 'Повторите проверку через 10 секунд');
        lastTest = Date.now();
        try { await notifications.send(channel, config, { subject: 'OpenDoist · Проверка уведомлений', text: 'Канал подключён. Здесь будут появляться напоминания и сводки дел.' }, `test:${randomBytes(16).toString('hex')}`); }
        catch { throw new AppError(502, 'Не удалось отправить. Проверьте параметры канала и доступность сервиса.'); }
        return send(200, { ok: true });
      }
      if (path === '/api/projects' && method === 'GET') return send(200, { projects: store.projects(), sections: store.sections() });
      const entityMatch = /^\/api\/(projects|sections)(?:\/([a-f0-9-]+))?$/.exec(path);
      if (entityMatch && ['POST', 'PATCH', 'DELETE'].includes(method)) {
        const [, collection, id] = entityMatch, body = await readJSON(req), kind = collection === 'projects' ? 'project' : 'section';
        if (method === 'POST' && !id) return send(201, { entity: store.saveEntity(kind, body) });
        if (method === 'PATCH' && id) return send(200, { entity: store.saveEntity(kind, body, id) });
        if (method === 'DELETE' && id) { store.deleteEntity(kind, id, body.revision); return send(200, { ok: true }); }
        throw new AppError(405, 'Метод не поддерживается');
      }
      if (path === '/api/settings' && method === 'GET') return send(200, { settings: store.settings() });
      if (path === '/api/settings' && method === 'PATCH') return send(200, { settings: store.saveSettings(await readJSON(req)) });
      if (path === '/api/tasks' && method === 'GET') return send(200, { tasks: store.list() });
      if (path === '/api/history' && method === 'GET') return send(200, { history: store.history() });
      if (['/api/import', '/api/import/preview'].includes(path) && method === 'POST') {
        const document = validateImport(await readJSON(req, IMPORT_LIMIT));
        return send(200, store.importTasks(document, path.endsWith('/preview')));
      }
      if (path === '/api/export' && method === 'GET') return send(200, { version: 1, exportedAt: new Date().toISOString(), tasks: store.list(), history: store.history(), projects: store.projects(), sections: store.sections() }, { 'Content-Disposition': 'attachment; filename="opendoist-export.json"' });
      if (path === '/api/parse' && method === 'POST') {
        const preview = parse(await readJSON(req));
        const upcoming = preview.parsed.recurrence?.mode === 'calendar' ? occurrences(preview.parsed, { after: preview.reference, count: 3 }) : [];
        return send(200, { ...preview, upcoming });
      }
      if (path === '/api/tasks' && method === 'POST') {
        const body = await readJSON(req), { parsed } = parse(body);
        return send(201, { task: store.create({ ...saveable(parsed), ...store.placement(body.projectId ?? null, body.sectionId ?? null) }) });
      }
      const reminderMatch = /^\/api\/tasks\/([a-f0-9-]+)\/reminders(?:\/([a-f0-9-]+))?$/.exec(path);
      if (reminderMatch && (method === 'POST' || method === 'DELETE')) {
        const body = await readJSON(req);
        if (!Number.isInteger(body.revision)) throw new AppError(400, 'Требуется версия задачи');
        const [, id, reminderId] = reminderMatch;
        if ((method === 'POST' && reminderId) || (method === 'DELETE' && !reminderId)) throw new AppError(405, 'Метод не поддерживается');
        const task = store.mutate(id, body.revision, previous => {
          const reminders = previous.reminders || [];
          if (method === 'POST') return { ...previous, reminders: [...reminders, makeReminder(body, previous, notifications.config())] };
          if (!reminders.some(r => r.id === reminderId)) throw new AppError(404, 'Напоминание не найдено');
          return { ...previous, reminders: reminders.filter(r => r.id !== reminderId) };
        });
        return send(method === 'POST' ? 201 : 200, { task });
      }
      const match = /^\/api\/tasks\/([a-f0-9-]+)(?:\/(complete|undo))?$/.exec(path);
      if (!match) throw new AppError(404, 'Не найдено');
      const body = await readJSON(req);
      if (!Number.isInteger(body.revision)) throw new AppError(400, 'Требуется версия задачи');
      const [, id, action] = match;
      if (method === 'POST' && action === 'complete') return send(200, { task: store.complete(id, body.revision) });
      if (method === 'POST' && action === 'undo') return send(200, { task: store.undo(id, body.revision) });
      if (method === 'DELETE' && !action) { store.mutate(id, body.revision, () => null); return send(200, { ok: true }); }
      if (method === 'PATCH' && !action) {
        const title = text(body.title);
        let schedule;
        if (body.source !== undefined) schedule = saveable(parse(body).parsed);
        const task = store.mutate(id, body.revision, previous => {
          const placement = store.placement(body.projectId === undefined ? previous.projectId ?? null : body.projectId, body.sectionId === undefined ? previous.sectionId ?? null : body.sectionId);
          const next = { ...previous, ...placement, ...(schedule || {}), deadline: schedule?.deadline ?? previous.deadline, title };
          if (body.clearSchedule === true) { next.due = null; next.recurrence = null; next.status = 'unscheduled'; }
          return next;
        });
        return send(200, { task });
      }
      throw new AppError(405, 'Метод не поддерживается');
    } catch (error) { send(error.status || 500, { error: error.status ? error.message : 'Ошибка сервера. Повторите запрос.' }); if (!error.status) console.error('Request failed:', error.name); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('close', () => store.close());
  return { server, store, notifications, telegram };
}
