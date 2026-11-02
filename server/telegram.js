import { createHash } from 'node:crypto';
import { parseTask } from '../src/index.js';
import { notificationDefaults } from './notifications.js';

export class TelegramInbox {
  constructor(store, { fetcher = fetch, now = Date.now } = {}) { this.store = store; this.fetcher = fetcher; this.now = now; this.running = null; this.status = { error: null, checkedAt: null }; }
  start() { this.timer = setInterval(() => this.tick().catch(() => {}), 5000); this.timer.unref(); this.tick().catch(() => {}); }
  async stop() { clearInterval(this.timer); await this.running; }
  tick() { if (!this.running) this.running = this.poll().finally(() => { this.running = null; }); return this.running; }
  async call(token, method, body) {
    const response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw Error(response.status === 409 ? 'Бот уже используется другим приложением или webhook. Используйте отдельного бота для этого сервера.' : 'Не удалось связаться с Telegram. Проверьте подключение бота.');
    return data.result;
  }
  async poll() {
    const config = { ...notificationDefaults().telegram, ...this.store.notificationConfig()?.telegram };
    if (!config.enabled || !config.acceptTasks) { this.status = { error: null, checkedAt: null }; return; }
    const key = createHash('sha256').update(config.token).digest('hex'), db = this.store.db;
    const offset = db.prepare('SELECT offset FROM telegram_cursors WHERE bot=?').get(key)?.offset || 0;
    try {
      const updates = await this.call(config.token, 'getUpdates', { offset, limit: 50, timeout: 0, allowed_updates: ['message'] });
      // Do not consume messages after the owner disabled or changed the connection.
      const latest = this.store.notificationConfig()?.telegram;
      if (!latest?.enabled || !latest.acceptTasks || latest.token !== config.token || latest.chatId !== config.chatId || latest.receiveSince !== config.receiveSince) return;
      for (const update of updates) this.consume(key, update, config);
      this.status = { error: null, checkedAt: this.now() };
      for (const reply of db.prepare('SELECT * FROM telegram_replies WHERE bot=? AND sent=0 AND attempts<5 AND next_attempt<=? LIMIT 10').all(key, this.now())) {
        if (reply.chat_id !== config.chatId) continue;
        try {
          await this.call(config.token, 'sendMessage', { chat_id: reply.chat_id, text: reply.text, link_preview_options: { is_disabled: true } });
          db.prepare('UPDATE telegram_replies SET sent=1 WHERE bot=? AND update_id=?').run(key, reply.update_id);
        } catch {
          db.prepare('UPDATE telegram_replies SET attempts=attempts+1,next_attempt=? WHERE bot=? AND update_id=?').run(this.now() + 60000, key, reply.update_id);
        }
      }
    } catch (error) { this.status = { error: error.message.startsWith('Бот уже') ? error.message : 'Не удалось связаться с Telegram. Проверьте подключение бота.', checkedAt: this.now() }; }
  }
  consume(bot, update, config) {
    if (!Number.isSafeInteger(update.update_id)) return;
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const offset = db.prepare('SELECT offset FROM telegram_cursors WHERE bot=?').get(bot)?.offset || 0;
      if (update.update_id < offset) { db.exec('COMMIT'); return; }
      const m = update.message;
      if (m?.chat?.type === 'private' && String(m.chat.id) === config.chatId && String(m.from?.id) === config.chatId && !m.from?.is_bot && Number.isSafeInteger(m.date) && m.date * 1000 >= config.receiveSince) {
        const reply = this.message(m);
        db.prepare('INSERT OR IGNORE INTO telegram_replies (bot,update_id,chat_id,text,next_attempt) VALUES (?,?,?,?,?)').run(bot, update.update_id, config.chatId, reply, this.now());
      }
      db.prepare('INSERT INTO telegram_cursors (bot,offset) VALUES (?,?) ON CONFLICT(bot) DO UPDATE SET offset=excluded.offset').run(bot, update.update_id + 1);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  message(message) {
    const text = message.text?.trim();
    if (!text) return 'Отправьте задачу текстом, например: «Купить молоко завтра в 18». Голосовые сообщения и файлы пока не поддерживаются.';
    if (/^\/(start|help)(?:@\w+)?(?:\s|$)/.test(text)) return 'Отправьте текст задачи с датой: «Купить молоко завтра в 18» или «Полив каждую пятницу».\nМожно начать с #Название проекта (для названия с пробелами: #"Мой проект").\n/projects — список проектов. /add текст — добавить задачу.';
    if (/^\/projects(?:@\w+)?$/.test(text)) return ('Проекты:\n' + this.store.projects().map(p => `${p.emoji || '•'} ${p.name}`).join('\n') + '\nБез #проекта задача попадёт во Входящие.').slice(0, 4000);
    let source = text.replace(/^\/add(?:@\w+)?\s+/, ''), projectId = null;
    if (source.startsWith('/')) return 'Неизвестная команда. /help — как добавить задачу.';
    if (source.startsWith('#')) {
      const match = /^#(?:"([^"]+)"|(\S+))\s+/.exec(source);
      const name = match && (match[1] || match[2]);
      const matches = name ? this.store.projects().filter(p => p.name.toLocaleLowerCase() === name.toLocaleLowerCase()) : [];
      const project = matches.length === 1 ? matches[0] : null;
      if (!project) return 'Проект не найден. Посмотрите /projects. Для названия с пробелами используйте #"Мой проект".';
      projectId = project.id; source = source.slice(match[0].length);
    }
    if (!source || source.length > 500) return 'Введите задачу длиной от 1 до 500 символов.';
    const settings = this.store.settings();
    let parsed;
    try { parsed = parseTask(source, { timezone: settings.timezone, language: settings.language, now: new Date(message.date * 1000) }); } catch { return 'Не удалось распознать задачу. Уточните дату и время.'; }
    if (parsed.status === 'needs_review' || !parsed.title.trim()) return 'Задача не добавлена: уточните название или неоднозначную дату.';
    const task = this.store.create({ ...parsed, projectId, sectionId: null });
    const project = this.store.projects().find(p => p.id === projectId);
    return `Добавлено: ${task.title}\n${project?.name || 'Входящие'}\n${task.due ? `${task.due.date}${task.due.time ? ` в ${task.due.time}` : ''} (${task.due.timezone})` : 'Без срока'}${task.recurrence ? '\n↻ Повторяющаяся задача' : ''}`;
  }
}
