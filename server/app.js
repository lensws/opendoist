import { attachmentMediaType, serveAttachment } from './attachment-media.js';
import { withDefaultReminder } from './default-reminder.js';
import { searchWorkspace } from './search.js';
import { BackupWorker } from './backups.js';
import { rescheduleTask } from './calendar.js';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { parseTask, occurrences } from '../src/index.js';
import { validateImport, IMPORT_LIMIT } from './import.js';
import { Store, AppError } from './store.js';
import { TelegramInbox } from './telegram.js';
import { NotificationWorker, publicConfig, validateConfig, makeReminder } from './notifications.js';

const assets = new Map(['settings-navigation.js', 'mobile-navigation.js', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'global-search.js', 'notes.js', 'workspace-data.js', 'task-tree.js', 'task-details.js', 'markdown.js', 'backups.js', 'index.html', 'app.js', 'style.css', 'icon.svg', 'appearance.js', 'notifications.js', 'transfer.js', 'projects.js', 'project-views.js', 'calendar-model.js', 'submit-shortcut.js', 'task-input.js', 'emoji-picker.js', 'emoji-search.js', 'emojis.json', 'emojis-LICENSE.txt'].map(name => [name, readFileSync(new URL(`../public/${name}`, import.meta.url))]));
const mime = { png:'image/png', webmanifest:'application/manifest+json; charset=utf-8', json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const SESSION_AGE = 7 * 86400 * 1000;
async function readJSON(req, limit = 16384) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, 'Ожидается JSON');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new AppError(413, 'Слишком большой запрос'); chunks.push(chunk); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || Array.isArray(body) || typeof body !== 'object') throw Error(); return body; }
  catch { throw new AppError(400, 'Некорректный JSON'); }
}
async function readFileBody(req) {
  if (req.headers['content-type'] !== 'application/octet-stream') throw new AppError(415, 'Ожидается файл');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new AppError(413, 'Файл больше 20 МБ'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function description(value = '') { if (typeof value !== 'string' || value.length > 20000) throw new AppError(400, 'Описание — до 20 000 символов'); return value; }
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
export function createApp({ password, database = './data/opendoist.sqlite', publicUrl, secureCookie = false, backupUpload, backupTester, notificationSender } = {}) {
  if (typeof password !== 'string' || password.length < 12 || password === 'change-this-before-use') throw new Error('Set OPENDOIST_PASSWORD to a unique password of at least 12 characters');
  const allowedOrigin = publicUrl ? new URL(publicUrl).origin : null;
  if (allowedOrigin?.startsWith('https:')) secureCookie = true;
  const store = new Store(database);
  const notifications = new NotificationWorker(store, { publicUrl: allowedOrigin || '', ...(notificationSender ? { send: notificationSender } : {}) });
  const telegram = new TelegramInbox(store);
  const backups = new BackupWorker(store, { database, ...(backupTester ? { testDestination:backupTester } : {}), ...(backupUpload ? { upload:backupUpload } : {}) });
  let lastTest = 0;
  const salt = randomBytes(32), expected = scryptSync(password, salt, 32);
  store.db.exec('CREATE TABLE IF NOT EXISTS account_auth (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, hash TEXT NOT NULL)');
  const verifyPassword = supplied => {
    if(typeof supplied !== 'string' || supplied.length > 1024)return false;
    const saved=store.db.prepare('SELECT salt,hash FROM account_auth WHERE id=1').get();
    return timingSafeEqual(scryptSync(supplied,saved ? Buffer.from(saved.salt,'hex') : salt,32),saved ? Buffer.from(saved.hash,'hex') : expected);
  };
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
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method)) return send(405, { error: 'Метод не поддерживается' });
      if (!['GET', 'HEAD'].includes(method)) {
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
        if (!verifyPassword(supplied)) throw new AppError(401, 'Неверный пароль');
        const token = randomBytes(32).toString('hex');
        store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
        store.db.prepare('INSERT INTO sessions VALUES (?,?)').run(sessionHash(token), Date.now() + SESSION_AGE);
        return send(200, { ok: true }, { 'Set-Cookie': cookie(token, SESSION_AGE / 1000) });
      }
      const token = /(?:^|;\s*)opendoist_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session = token && store.db.prepare('SELECT expires FROM sessions WHERE hash=?').get(sessionHash(token));
      if (!session || session.expires < Date.now()) throw new AppError(401, 'Войдите в приложение');
      if (path === '/api/account/password' && method === 'POST') {
        const body=await readJSON(req);
        attempts=attempts.filter(t=>t>Date.now()-60000);
        if(attempts.length>=10)throw new AppError(429,'Слишком много попыток. Попробуйте через минуту.');
        attempts.push(Date.now());
        if(!verifyPassword(body.currentPassword))throw new AppError(403,'Текущий пароль неверен');
        if(typeof body.newPassword!=='string' || body.newPassword.length<12 || body.newPassword.length>1024 || body.newPassword==='change-this-before-use')throw new AppError(400,'Новый пароль — от 12 до 1024 символов');
        if(body.newPassword!==body.confirmPassword)throw new AppError(400,'Новые пароли не совпадают');
        const nextSalt=randomBytes(32),hash=scryptSync(body.newPassword,nextSalt,32),nextToken=randomBytes(32).toString('hex');
        store.db.exec('BEGIN IMMEDIATE');
        try {
          store.db.prepare('INSERT INTO account_auth VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET salt=excluded.salt,hash=excluded.hash').run(nextSalt.toString('hex'),hash.toString('hex'));
          store.db.prepare('DELETE FROM sessions').run();
          store.db.prepare('INSERT INTO sessions VALUES (?,?)').run(sessionHash(nextToken),Date.now()+SESSION_AGE);
          store.db.exec('COMMIT');
        }catch(error){store.db.exec('ROLLBACK');throw error;}
        return send(200,{ok:true},{'Set-Cookie':cookie(nextToken,SESSION_AGE/1000)});
      }
      if (path === '/api/session' && method === 'GET') return send(200, { ok: true });
      if (path === '/api/logout' && method === 'POST') {
        store.db.prepare('DELETE FROM sessions WHERE hash=?').run(sessionHash(token));
        return send(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
      }
      if (path === '/api/backups' && method === 'GET') return send(200, { config:backups.status() });
      if (path === '/api/backups' && method === 'PATCH') return send(200, { config:backups.save(await readJSON(req)) });
      if (path === '/api/backups/test' && method === 'POST') return send(200, await backups.test(await readJSON(req)));
      if (path === '/api/backups/run' && method === 'POST') { backups.run(); return send(202, { config:backups.status() }); }
      const fileMatch = /^\/api\/tasks\/([a-f0-9-]+)\/attachments(?:\/([a-f0-9-]+))?$/.exec(path);
      if (fileMatch) {
        const [, taskId, fileId] = fileMatch; store.get(taskId);
        if (method === 'GET' && !fileId) return send(200, { files:store.attachments(taskId).map(file => ({ ...file, mediaType:attachmentMediaType(file.name) })) });
        if (method === 'POST' && !fileId) {
          let name; try { name = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { throw new AppError(400, 'Некорректное имя файла'); }
          return send(201, { file:store.addAttachment(taskId, name, await readFileBody(req)) });
        }
        const file = fileId && store.db.prepare('SELECT id,name,length(data) AS size FROM attachments WHERE id=? AND task_id=?').get(fileId, taskId);
        if (!file) throw new AppError(404, 'Файл не найден');
        if (method === 'GET' || method === 'HEAD') return serveAttachment(req, res, file, headers, () => store.db.prepare('SELECT data FROM attachments WHERE id=? AND task_id=?').get(fileId, taskId).data);
        if (method === 'DELETE') { store.db.prepare('DELETE FROM attachments WHERE id=?').run(fileId); return send(200, { ok:true }); }
        throw new AppError(405, 'Метод не поддерживается');
      }
      const moveMatch = /^\/api\/tasks\/([a-f0-9-]+)\/move$/.exec(path);
      if (moveMatch && method === 'POST') return send(200, { task:store.moveTask(moveMatch[1], await readJSON(req, 1024 * 1024)) });
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
      if (path === '/api/projects/order' && method === 'PATCH') { const body = await readJSON(req); return send(200, { projects: store.reorderProjects(body.ids, body.previousIds) }); }
      const projectViewMatch = /^\/api\/projects\/([a-f0-9-]+)\/view$/.exec(path);
      if (projectViewMatch && method === 'PATCH') return send(200, { project: store.saveProjectView(projectViewMatch[1], await readJSON(req)) });
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
      if (path === '/api/search' && method === 'GET') {
        const q=new URL(req.url,'http://localhost').searchParams.get('q') || '';
        if(q.length>200) throw new AppError(400,'Поисковый запрос — до 200 символов');
        return send(200,searchWorkspace(store,q));
      }
      if (path === '/api/notes' && method === 'GET') return send(200,{notes:store.notes()});
      if (path === '/api/notes' && method === 'POST') return send(201,{note:store.saveNote(await readJSON(req,Infinity))});
      const noteMatch=/^\/api\/notes\/([a-f0-9-]+)$/.exec(path);
      if (noteMatch) {
        if (method === 'GET') return send(200,{note:store.note(noteMatch[1])});
        if (method === 'PATCH') return send(200,{note:store.saveNote(await readJSON(req,Infinity),noteMatch[1])});
        if (method === 'DELETE') { const body=await readJSON(req); store.deleteNote(noteMatch[1],body.revision); return send(200,{ok:true}); }
      }
      if (path === '/api/tasks' && method === 'GET') return send(200, { tasks: store.list() });
      if (path === '/api/history' && method === 'GET') return send(200, { history: store.history() });
      if (['/api/import', '/api/import/preview'].includes(path) && method === 'POST') {
        const document = validateImport(await readJSON(req, IMPORT_LIMIT));
        return send(200, store.importTasks(document, path.endsWith('/preview')));
      }
      if (path === '/api/export' && method === 'GET') return send(200, { version: 1, exportedAt: new Date().toISOString(), tasks: store.list(), history: store.history(), projects: store.projects(), sections: store.sections(), notes:store.notes(true) }, { 'Content-Disposition': 'attachment; filename="opendoist-export.json"' });
      if (path === '/api/parse' && method === 'POST') {
        const preview = parse(await readJSON(req));
        const upcoming = preview.parsed.recurrence?.mode === 'calendar' ? occurrences(preview.parsed, { after: preview.reference, count: 3 }) : [];
        return send(200, { ...preview, upcoming });
      }
      if (path === '/api/tasks' && method === 'POST') {
        const body = await readJSON(req, 100000);
        if (body.withoutSchedule !== undefined && typeof body.withoutSchedule !== 'boolean') throw new AppError(400, 'Некорректный выбор срока');
        const parsed = body.withoutSchedule ? { source:text(body.source), title:text(body.source), language:['ru','en'].includes(body.language) ? body.language : 'auto', status:'unscheduled', due:null, recurrence:null, deadline:null, spans:[], warnings:[] } : parse(body).parsed;
        return send(201, { task: store.create(withDefaultReminder({ ...saveable(parsed), description:description(body.description), parentId:body.parentId ?? null, ...store.placement(body.projectId ?? null, body.sectionId ?? null) }, notifications.config())) });
      }
      const rescheduleMatch = /^\/api\/tasks\/([a-f0-9-]+)\/reschedule$/.exec(path);
      if (rescheduleMatch && method === 'POST') {
        const body = await readJSON(req);
        return send(200, { task: store.mutate(rescheduleMatch[1], body.revision, task => withDefaultReminder(rescheduleTask(task, body), notifications.config(), task)) });
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
      const body = await readJSON(req, 100000);
      if (!Number.isInteger(body.revision)) throw new AppError(400, 'Требуется версия задачи');
      const [, id, action] = match;
      if (method === 'POST' && action === 'complete') return send(200, { task: store.complete(id, body.revision) });
      if (method === 'POST' && action === 'undo') return send(200, { task: store.undo(id, body.revision) });
      if (method === 'DELETE' && !action) { store.mutate(id, body.revision, () => null); return send(200, { ok: true }); }
      if (method === 'PATCH' && !action) {
        let title = text(body.title);
        let schedule;
        if (body.source !== undefined) schedule = saveable(parse(body).parsed);
        else if (body.parseTitle === true && body.clearSchedule !== true) {
          const parsed=parse({...body,source:title}).parsed;
          if(parsed.status!=='needs_review' && (parsed.due || parsed.recurrence || parsed.deadline || parsed.dateAction==='clear')){schedule=saveable(parsed);title=schedule.title;}
        }
        const task = store.mutate(id, body.revision, previous => {
          const placement = store.placement(body.projectId === undefined ? previous.projectId ?? null : body.projectId, body.sectionId === undefined ? previous.sectionId ?? null : body.sectionId);
          const next = { ...previous, ...placement, ...(schedule || {}), deadline: schedule?.deadline ?? previous.deadline, description:body.description === undefined ? previous.description || '' : description(body.description), title };
          if (body.clearSchedule === true) { next.due = null; next.recurrence = null; next.status = 'unscheduled'; }
          return withDefaultReminder(next, notifications.config(), previous);
        });
        return send(200, { task });
      }
      throw new AppError(405, 'Метод не поддерживается');
    } catch (error) { send(error.status || 500, { error: error.status ? error.message : 'Ошибка сервера. Повторите запрос.' }); if (!error.status) console.error('Request failed:', error.name); }
  });
  server.requestTimeout = 120000; // Allow bounded file uploads on slower connections.
  server.headersTimeout = 10000;
  server.on('close', async () => { await backups.stop(); store.close(); });
  return { server, store, notifications, telegram, backups };
}
