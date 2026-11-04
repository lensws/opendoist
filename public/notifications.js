export function initNotifications({ api, reload, getSettings, notify }) {
  const $ = selector => document.querySelector(selector);
  let task, config, settingsLoad=0;
  const node = (tag, text, className = '') => { const el = document.createElement(tag); el.textContent = text; el.className = className; return el; };
  const picked = prefix => ['email', 'telegram'].filter(c => $(`#${prefix}-${c}`).checked);
  const localDate = (at, zone) => new Date(at).toLocaleString('ru', { timeZone: zone });
  function reminderLabel(r) { return r.kind === 'before' ? r.minutes === 0 ? 'В момент срока' : `За ${r.minutes} мин. до задачи` : `${localDate(r.at, r.timezone)} · ${r.timezone}`; }
  function drawReminders() {
    $('#reminder-task-title').textContent = task.title;
    const list = $('#reminder-list'); list.replaceChildren();
    for (const r of task.reminders || []) {
      const row = node('div', '', 'reminder-row');
      const label = node('div', reminderLabel(r)); label.append(node('div', r.channels.join(' · '), 'muted small'));
      const remove = node('button', '×', 'icon-button'); remove.type = 'button'; remove.setAttribute('aria-label', `Удалить напоминание: ${reminderLabel(r)}`);
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try { task = (await api(`/tasks/${task.id}/reminders/${r.id}`, { method: 'DELETE', body: { revision: task.revision } })).task; drawReminders(); await reload(); }
        catch (e) { $('#reminder-error').textContent = e.message; remove.disabled = false; }
      });
      row.append(label, remove); list.append(row);
    }
    if (!task.reminders?.length) list.append(node('p', 'Напоминаний пока нет.', 'muted small'));
  }
  function switchKind() {
    const before = $('#reminder-kind').value === 'before';
    $('#reminder-before').hidden = !before; $('#reminder-absolute').hidden = before;
    $('#reminder-amount').required = before; $('#reminder-local').required = !before; $('#reminder-zone').required = !before;
  }
  async function openReminders(selected) {
    task = selected;
    try {
      config = (await api('/notifications')).config;
      $('#reminder-error').textContent = '';
      $('#reminder-kind').value = task.due?.instant && !task.due.allDay ? 'before' : 'absolute';
      $('#reminder-amount').value = '10'; $('#reminder-unit').value = '1'; $('#reminder-local').value = '';
      $('#reminder-zone').value = task.due?.timezone || getSettings().timezone;
      for (const channel of ['email', 'telegram']) { $(`#reminder-${channel}`).disabled = !config[channel].enabled; $(`#reminder-${channel}`).checked = config[channel].enabled; }
      $('#reminder-channel-note').textContent = ['email', 'telegram'].some(c => config[c].enabled) ? 'Отправим в выбранные каналы.' : 'Сначала подключите email или Telegram в настройках.';
      drawReminders(); switchKind(); $('#reminders-dialog').showModal();
    } catch (e) { notify(e.message); }
  }
  $('#reminder-kind').addEventListener('change', switchKind);
  $('#reminder-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; $('#reminder-error').textContent = '';
    try {
      task = (await api(`/tasks/${task.id}/reminders`, { method: 'POST', body: { revision: task.revision, kind: $('#reminder-kind').value, minutes: Number($('#reminder-amount').value) * Number($('#reminder-unit').value), local: $('#reminder-local').value, timezone: $('#reminder-zone').value.trim(), channels: picked('reminder') } })).task;
      drawReminders(); await reload(); notify('Напоминание добавлено');
    } catch (e) { $('#reminder-error').textContent = e.message; } finally { button.disabled = false; }
  });
  function fillConfig(c) {
    config = c;
    for (const key of ['host', 'port', 'user', 'from', 'to']) $(`#email-${key}`).value = c.email[key];
    $('#email-enabled').checked = c.email.enabled; $('#email-secure').checked = c.email.secure;
    $('#email-password').value = ''; $('#telegram-token').value = '';
    $('#email-secret-note').textContent = c.email.passwordSet ? 'Пароль сохранён. Оставьте поле пустым, чтобы сохранить его.' : 'Используйте пароль приложения, если этого требует почтовый сервис.';
    $('#telegram-secret-note').textContent = c.telegram.tokenSet ? 'Токен сохранён. Оставьте поле пустым, чтобы сохранить его.' : 'Токен выдаёт @BotFather.';
    $('#telegram-accept-tasks').checked = !!c.telegram.acceptTasks; $('#telegram-enabled').checked = c.telegram.enabled; $('#telegram-chat').value = c.telegram.chatId;
    $('#email-state').textContent = c.email.enabled ? 'Включён' : 'Не подключён'; $('#telegram-state').textContent = c.telegram.enabled ? 'Включён' : 'Не подключён';
    $('#digest-enabled').checked = c.digest.enabled; $('#digest-mode').value = c.digest.mode; $('#digest-time').value = c.digest.time; $('#digest-zone').value = c.digest.timezone;
    for (const channel of ['email', 'telegram']) $(`#digest-${channel}`).checked = c.digest.channels.includes(channel);
  }
  async function openNotifications() {
    $('#reminders-dialog').close(); if (!$('#settings-dialog').open) $('#settings-open').click(); $('#settings-dialog').dispatchEvent(new CustomEvent('settings-section',{detail:'notifications'}));
    const sequence=++settingsLoad;
    try {
      const result = await api('/notifications'); if(sequence!==settingsLoad)return; fillConfig(result.config); $('#telegram-inbox-status').textContent = result.telegram?.error || (result.config.telegram.acceptTasks ? 'Приём задач включён. Команда /help в боте покажет примеры.' : 'Приём задач выключен.');
      $('#email-details').open = config.email.enabled; $('#telegram-details').open = config.telegram.enabled;
      const list = $('#notification-deliveries'); list.replaceChildren();
      const statuses = { pending: 'Ожидает отправки', sent: 'Отправлено', failed: 'Не доставлено', cancelled: 'Отменено' };
      for (const row of result.deliveries) list.append(node('p', `${localDate(row.sent_at || row.scheduled, getSettings().timezone)} · ${row.channel} · ${statuses[row.status]}${row.last_error ? ` · ${row.last_error}` : ''}`));
      if (!result.deliveries.length) list.append(node('p', 'Отправок пока нет.', 'muted'));
      $('#notifications-error').textContent = ''; $('#notifications-status').textContent = '';

    } catch (e) { $('#settings-dialog').dispatchEvent(new CustomEvent('settings-load-error',{detail:'notifications'})); notify(e.message); }
  }
  $('#notifications-open').addEventListener('click', openNotifications);
  $('#reminder-connect').addEventListener('click', openNotifications);
  $('#digest-mode').addEventListener('change', () => { $('#digest-time').value = $('#digest-mode').value === 'morning' ? '08:00' : '20:00'; });
  $('#notifications-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; $('#notifications-error').textContent = ''; $('#notifications-status').textContent = '';
    const body = { email: { enabled: $('#email-enabled').checked, secure: $('#email-secure').checked, port: Number($('#email-port').value), password: $('#email-password').value }, telegram: { enabled: $('#telegram-enabled').checked, acceptTasks: $('#telegram-accept-tasks').checked, token: $('#telegram-token').value.trim(), chatId: $('#telegram-chat').value.trim() }, digest: { enabled: $('#digest-enabled').checked, mode: $('#digest-mode').value, time: $('#digest-time').value, timezone: $('#digest-zone').value.trim(), channels: picked('digest') } };
    // A disabled digest may keep its default channel until the user selects one.
    if (!body.digest.enabled && !body.digest.channels.length) body.digest.channels = ['email'];
    for (const key of ['host', 'user', 'from', 'to']) body.email[key] = $(`#email-${key}`).value.trim();
    try { fillConfig((await api('/notifications', { method: 'PATCH', body })).config); $('#notifications-status').textContent = 'Настройки сохранены на сервере.'; }
    catch (e) { $('#notifications-error').textContent = e.message; } finally { button.disabled = false; }
  });
  for (const channel of ['email', 'telegram']) $(`#test-${channel}`).addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; $('#notifications-error').textContent = ''; $('#notifications-status').textContent = 'Отправляем тестовое сообщение…';
    try { await api('/notifications/test', { method: 'POST', body: { channel } }); $('#notifications-status').textContent = 'Тестовое сообщение отправлено.'; }
    catch (e) { $('#notifications-status').textContent = ''; $('#notifications-error').textContent = e.message; } finally { button.disabled = false; }
  });
  $('#settings-dialog').addEventListener('close', () => { settingsLoad++; $('#email-password').value = ''; $('#telegram-token').value = ''; });
  return { openReminders };
}
