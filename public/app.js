import { initTaskInput } from './task-input.js';
import { initProjects } from './projects.js';
import { initTransfer } from './transfer.js';
import { initNotifications } from './notifications.js';
const $ = selector => document.querySelector(selector);
let tasks = [], history = [], projects = [], sections = [], view = 'all', preview = null, editTask = null, previewSequence = 0, timer, toastTimer;
let composerOpen = false;
let settings;
try { settings = JSON.parse(localStorage.getItem('opendoist.settings')) || {}; } catch { settings = {}; }
settings = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow', language: 'auto', ...settings, ...window.OpenDoistAppearance.normalize(settings) };
try { new Intl.DateTimeFormat('ru', { timeZone: settings.timezone }); } catch { settings.timezone = 'Europe/Moscow'; }
const titles = { inbox: 'Входящие', all: 'Все задачи', today: 'Сегодня', upcoming: 'Предстоящие', completed: 'Выполненные', history: 'История' };
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/login') showLogin(); const error = new Error(data.error || 'Не удалось выполнить запрос'); error.status = response.status; throw error; }
  return data;
}
const projectUI = initProjects({ api, getData: () => ({ projects, sections, tasks }), reload: load, selectView: next => { view = next; render(); }, notify });
const taskInput = initTaskInput({ getProjects: () => projects, chooseProject: id => projectUI.fillPlacement('add', id, '') });
initTransfer({ api, reload: async () => { ({ projects, sections } = await api('/projects')); tasks = (await api('/tasks')).tasks; if (view === 'history') history = (await api('/history')).history; render(); }, notify });
const { openReminders } = initNotifications({ api, reload: load, getSettings: () => settings, notify });
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function today(zone = settings.timezone) { return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function dateLabel(due) {
  if (!due) return 'Без срока';
  const current = today(due.timezone);
  const day = new Date(`${due.date}T12:00:00Z`);
  const tomorrow = new Date(`${current}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const label = due.date === current ? 'Сегодня' : due.date === tomorrow.toISOString().slice(0, 10) ? 'Завтра' : day.toLocaleDateString('ru', { day: 'numeric', month: 'short', ...(due.date.slice(0, 4) !== current.slice(0, 4) ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  return `${label}${due.time ? ` · ${due.time}` : ''}${due.timezone !== settings.timezone ? ` · ${due.timezone}` : ''}`;
}
function recurringLabel(task) {
  if (!task.recurrence) return '';
  const spans = task.spans?.filter(s => s.kind === 'recurrence' || s.kind === 'mode');
  return spans?.length ? spans.map(s => s.text).join(' ') : 'Повторяется';
}
function showLogin() { $('#workspace').hidden = true; $('#login-screen').hidden = false; tasks = []; history = []; $('#task-list').replaceChildren(); for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); }
async function loadSettings() {
  settings = (await api('/settings')).settings;
  window.OpenDoistAppearance.apply(settings);
  // Optional first-paint cache; the server remains the source of truth.
  try { localStorage.setItem('opendoist.settings', JSON.stringify(settings)); } catch { /* Storage is optional. */ }
}
async function load() {
  await loadSettings();
  const result = await api('/tasks'); tasks = result.tasks;
  ({ projects, sections } = await api('/projects'));
  if (view === 'history') history = (await api('/history')).history;
  render();
}
function overdue(task) { return task.due && !task.completedAt && (task.due.allDay ? task.due.date < today(task.due.timezone) : Date.parse(task.due.instant) < Date.now()); }
function meta(task) {
  const el = node('div', 'task-meta');
  if (task.due) el.append(node('span', `date-pill${overdue(task) ? ' overdue' : ''}`, `${overdue(task) ? '◷ ' : '▦ '}${dateLabel(task.due)}`));
  if (task.recurrence) el.append(node('span', 'recurrence-pill', `↻ ${recurringLabel(task)}`));
  if (task.deadline) el.append(node('span', 'deadline-pill', `Дедлайн: ${dateLabel(task.deadline)}`));
  const project = projects.find(p => p.id === task.projectId), section = sections.find(s => s.id === task.sectionId);
  if (project) el.append(node('span', 'project-pill', `${project.emoji || '#'} ${project.name}${section ? ` / ${section.name}` : ''}`));
  return el;
}
function actionButton(label, symbol, handler, className = '') { const button = node('button', `icon-button ${className}`, symbol); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.addEventListener('click', handler); return button; }
function render() {
  $('#page-error').textContent = '';
  const entity = view.startsWith('project:') ? projects.find(p => p.id === view.slice(8)) : view.startsWith('section:') ? sections.find(s => s.id === view.slice(8)) : null;
  if (!titles[view] && !entity) view = 'inbox';
  $('#view-title').textContent = entity?.name || titles[view];
  projectUI.draw(view);
  document.querySelectorAll('[data-view]').forEach(el => { const active = el.dataset.view === view; el.classList.toggle('active', active); if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  const active = tasks.filter(t => !t.completedAt);
  const filters = { inbox: active.filter(t => !t.projectId), all: active, today: active.filter(t => t.due && t.due.date <= today(t.due.timezone)), upcoming: active.filter(t => t.due && t.due.date > today(t.due.timezone)), completed: tasks.filter(t => t.completedAt) };
  for (const key of Object.keys(filters)) $(`#count-${key}`).textContent = filters[key].length;
  const query = $('#search').value.trim().toLocaleLowerCase();
  const list = $('#task-list'); list.replaceChildren();
  $('#empty h2').textContent = query ? 'Ничего не найдено' : view === 'today' ? 'На сегодня всё' : view === 'completed' ? 'Первые победы впереди' : view === 'history' ? 'История пока пуста' : 'Здесь пока спокойно';
  $('#empty p').textContent = query ? 'Попробуйте другое название.' : view === 'today' ? 'Можно выдохнуть — или выбрать следующий шаг.' : ['completed', 'history'].includes(view) ? 'Завершённые задачи появятся здесь.' : 'Добавьте задачу. Даже большой план начинается с маленького шага.';
  syncComposer();
  if (view === 'history') {
    const rows = history.filter(h => h.task.title.toLocaleLowerCase().includes(query));
    for (const item of rows) { const row = node('article', 'task done'); row.append(node('span', 'task-check', '✓')); const content = node('div', 'task-main'); content.append(node('div', 'task-title', item.task.title), meta(item.task), node('div', 'task-meta', `Выполнено ${new Date(item.completedAt).toLocaleString('ru', { timeZone: settings.timezone })}`)); row.append(content); list.append(row); }
    $('#task-summary').textContent = `Выполнений: ${rows.length}`; $('#empty').hidden = !!rows.length; return;
  }
  const selected = (entity ? active.filter(t => view.startsWith('project:') ? t.projectId === entity.id : t.sectionId === entity.id) : filters[view]).filter(t => t.title.toLocaleLowerCase().includes(query)).sort((a, b) => (view.startsWith('project:') ? sections.findIndex(s => s.id === a.sectionId) - sections.findIndex(s => s.id === b.sectionId) : 0) || (a.due?.date || '9999').localeCompare(b.due?.date || '9999') || (a.due?.time || '').localeCompare(b.due?.time || '') || b.createdAt.localeCompare(a.createdAt));
  $('#task-summary').textContent = `Задач: ${selected.length}`; $('#empty').hidden = !!selected.length;
  let lastGroup;
  for (const task of selected) {
    const group = view.startsWith('project:') ? sections.find(s => s.id === task.sectionId)?.name || 'Без раздела' : task.completedAt ? 'Готово' : overdue(task) ? 'Просрочено' : task.due ? dateLabel({ ...task.due, time: null }) : 'Без срока';
    if (group !== lastGroup) { list.append(node('h2', 'group-heading', group)); lastGroup = group; }
    const row = node('article', `task${task.completedAt ? ' done' : ''}`);
    const check = node('button', 'task-check', task.completedAt ? '✓' : ''); check.type = 'button'; check.title = task.completedAt ? 'Отменить выполнение' : 'Выполнить задачу'; check.setAttribute('aria-label', `${check.title}: ${task.title}`);
    check.addEventListener('click', async () => {
      check.disabled = true;
      try { const result = await api(`/tasks/${task.id}/${task.completedAt ? 'undo' : 'complete'}`, { method: 'POST', body: { revision: task.revision } }); await load(); notify(task.completedAt ? 'Задача возвращена' : result.task.completedAt ? 'Готово. Ещё один шаг!' : `Следующий срок: ${dateLabel(result.task.due)}`, task.completedAt ? null : async () => { await api(`/tasks/${task.id}/undo`, { method: 'POST', body: { revision: result.task.revision } }); await load(); }); }
      catch (e) { $('#page-error').textContent = e.message; check.disabled = false; }
    });
    const content = node('div', 'task-main'); content.append(node('div', 'task-title', task.title), meta(task));
    const actions = node('div', 'task-actions');
    if (!task.completedAt) {
      actions.append(actionButton('Напомнить', task.reminders?.length ? `🔔 ${task.reminders.length}` : '🔔 Напомнить', () => openReminders(task), 'reminder-action'));
      actions.append(actionButton('Редактировать задачу', '✎', () => openEdit(task)));
    }
    actions.append(actionButton('Удалить задачу', '×', async () => {
      if (!confirm(`Удалить «${task.title}» и историю её выполнений?`)) return;
      try { await api(`/tasks/${task.id}`, { method: 'DELETE', body: { revision: task.revision } }); await load(); notify('Задача удалена'); } catch (e) { $('#page-error').textContent = e.message; }
    }, 'delete'));
    row.append(check, content, actions); list.append(row);
  }
}
function previewText(result) {
  const t = result.parsed;
  if (t.status === 'needs_review') return 'Не удалось распознать срок. Попробуйте уточнить формулировку.';
  if (!t.title) return 'Добавьте название перед датой.';
  let message = t.dateAction === 'clear' ? 'Без срока' : dateLabel(t.due);
  if (t.recurrence) message += ` · ↻ ${recurringLabel(t)}`;
  if (t.deadline) message += ` · Дедлайн: ${dateLabel(t.deadline)}`;
  if (result.upcoming.length) message += ` · Далее: ${result.upcoming.map(d => dateLabel(d)).join(' → ')}`;
  if (t.warnings.length) message += ' · Дата неоднозначна — проверьте результат.';
  return message;
}
async function refreshPreview() {
  const sequence = ++previewSequence; preview = null; $('#add-submit').disabled = true;
  const source = $('#task-input').value.trim(); const el = $('#preview');
  el.className = 'preview';
  el.hidden = !source;
  if (!source) { el.textContent = ''; taskInput.highlight(); return; }
  el.textContent = 'Распознаём дату…';
  try {
    const result = await api('/parse', { method: 'POST', body: { source, ...settings } });
    if (sequence !== previewSequence) return;
    taskInput.highlight(source, result.parsed.status === 'needs_review' ? [] : result.parsed.spans);
    preview = { ...result, source }; el.textContent = previewText(result);
    const valid = result.parsed.status !== 'needs_review' && !!result.parsed.title;
    el.className = `preview ${valid ? 'ready' : 'error'}`; $('#add-submit').disabled = !valid;
  } catch (e) { if (sequence === previewSequence) { el.className = 'preview error'; el.textContent = e.message; } }
}
$('#task-input').addEventListener('input', () => { previewSequence++; preview = null; $('#add-submit').disabled = true; clearTimeout(timer); timer = setTimeout(refreshPreview, 250); });
$('#add-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!preview || preview.source !== $('#task-input').value.trim()) return;
  $('#add-submit').disabled = true;
  try { await api('/tasks', { method: 'POST', body: { source: preview.source, reference: preview.reference, ...settings, ...projectUI.placement('add') } }); $('#task-input').value = ''; await refreshPreview(); composerOpen = false; await load(); $('#add-open').focus(); notify('Задача добавлена'); }
  catch (e) { $('#page-error').textContent = e.message; $('#add-submit').disabled = false; }
});
document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', async () => { view = el.dataset.view; try { await load(); } catch (e) { $('#page-error').textContent = e.message; } }));
$('#search').addEventListener('input', render);
function syncComposer() {
  const unavailable = ['completed', 'history'].includes(view);
  $('#add-form').hidden = unavailable || !composerOpen;
  $('#add-open').hidden = unavailable || composerOpen;
  $('#add-open').setAttribute('aria-expanded', String(composerOpen && !unavailable));
}
function focusAdd() { if (['completed', 'history'].includes(view)) { view = 'all'; render(); } composerOpen = true; syncComposer(); $('#task-input').focus(); }
function closeComposer() { taskInput.hide(); composerOpen = false; syncComposer(); $('#add-open').focus(); }
$('#add-open').addEventListener('click', focusAdd);
$('#add-cancel').addEventListener('click', closeComposer);
$('#add-form').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeComposer(); } });
$('#focus-add').addEventListener('click', focusAdd);
document.addEventListener('keydown', event => { if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && !document.querySelector('dialog[open]') && !$('#workspace').hidden) { event.preventDefault(); focusAdd(); } });
function notify(message, undo = null) {
  clearTimeout(toastTimer); $('#toast-text').textContent = message; $('#toast').hidden = false; $('#toast-undo').hidden = !undo;
  $('#toast-undo').onclick = async () => { $('#toast-undo').disabled = true; try { await undo(); $('#toast').hidden = true; } catch (e) { $('#toast-text').textContent = e.message; } finally { $('#toast-undo').disabled = false; } };
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 9000);
}
function openEdit(task) { editTask = task; projectUI.fillPlacement('edit', task.projectId, task.sectionId); $('#edit-title').value = task.title; $('#edit-schedule').value = ''; $('#edit-clear').checked = false; $('#edit-preview').textContent = `Текущий срок: ${dateLabel(task.due)}${task.recurrence ? ` · ${recurringLabel(task)}` : ''}`; $('#edit-error').textContent = ''; $('#edit-dialog').showModal(); }
let editTimer, editSequence = 0;
$('#edit-schedule').addEventListener('input', () => {
  clearTimeout(editTimer); const sequence = ++editSequence;
  editTimer = setTimeout(async () => { if (!$('#edit-schedule').value.trim()) { $('#edit-preview').textContent = 'Текущее расписание сохранится.'; return; } try { const result = await api('/parse', { method: 'POST', body: { source: `Task ${$('#edit-schedule').value}`, ...settings, timezone: editTask.due?.timezone || settings.timezone } }); if (sequence === editSequence) $('#edit-preview').textContent = previewText(result); } catch (e) { if (sequence === editSequence) $('#edit-preview').textContent = e.message; } }, 250);
});
$('#edit-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const body = { title: $('#edit-title').value.trim(), revision: editTask.revision, clearSchedule: $('#edit-clear').checked, ...projectUI.placement('edit') };
  const expression = $('#edit-schedule').value.trim();
  if (expression && !body.clearSchedule) { body.source = `Task ${expression}`; Object.assign(body, settings, { timezone: editTask.due?.timezone || settings.timezone }); }
  try { await api(`/tasks/${editTask.id}`, { method: 'PATCH', body }); $('#edit-dialog').close(); await load(); notify('Изменения сохранены'); }
  catch (e) { $('#edit-error').textContent = e.message; } finally { button.disabled = false; }
});
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => document.getElementById(el.dataset.close).close()));
function appearanceDraft() {
  return { theme: $('#settings-form input[name="theme"]:checked')?.value || 'system', accent: $('#accent-color').value };
}
function previewAppearance() {
  const draft = appearanceDraft();
  window.OpenDoistAppearance.apply(draft);
  document.querySelectorAll('[data-accent]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.accent === draft.accent)));
}
$('#settings-open').addEventListener('click', () => {
  $('#timezone').value = settings.timezone; $('#language').value = settings.language;
  document.querySelectorAll('input[name="theme"]').forEach(input => { input.checked = input.value === settings.theme; });
  $('#accent-color').value = settings.accent;
  $('#settings-error').textContent = ''; previewAppearance(); $('#settings-dialog').showModal();
});
document.querySelectorAll('input[name="theme"]').forEach(input => input.addEventListener('change', previewAppearance));
document.querySelectorAll('[data-accent]').forEach(button => button.addEventListener('click', () => { $('#accent-color').value = button.dataset.accent; previewAppearance(); }));
$('#accent-color').addEventListener('input', previewAppearance);
// close covers Cancel, the close button, Escape, and expired-session dismissal.
$('#settings-dialog').addEventListener('close', () => window.OpenDoistAppearance.apply(settings));
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault(); const timezone = $('#timezone').value.trim();
  try { new Intl.DateTimeFormat('ru', { timeZone: timezone }); } catch { $('#settings-error').textContent = 'Укажите часовой пояс, например Europe/Moscow'; return; }
  const next = { ...settings, timezone, language: $('#language').value, ...appearanceDraft() };
  const button = event.submitter; button.disabled = true;
  try {
    settings = (await api('/settings', { method: 'PATCH', body: next })).settings;
    try { localStorage.setItem('opendoist.settings', JSON.stringify(settings)); } catch { /* Storage is optional. */ }
    window.OpenDoistAppearance.apply(settings); $('#settings-dialog').close(); render(); refreshPreview();
  } catch (error) { $('#settings-error').textContent = error.message; }
  finally { button.disabled = false; }
});
window.addEventListener('focus', async () => {
  if ($('#workspace').hidden || document.querySelector('dialog[open]')) return;
  try { await load(); refreshPreview(); } catch (error) { $('#page-error').textContent = error.message; }
});
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true; $('#login-error').textContent = '';
  try { await api('/login', { method: 'POST', body: { password: $('#password').value } }); $('#password').value = ''; $('#login-screen').hidden = true; $('#workspace').hidden = false; await load(); }
  catch (e) { $('#login-error').textContent = e.message; } finally { event.submitter.disabled = false; }
});
$('#logout').addEventListener('click', async () => { try { await api('/logout', { method: 'POST', body: {} }); showLogin(); } catch (e) { $('#page-error').textContent = e.message; } });
try { await api('/session'); $('#workspace').hidden = false; await load(); } catch (e) { showLogin(); if (e.status !== 401) $('#login-error').textContent = 'Сервер недоступен. Обновите страницу.'; }

setInterval(async () => { if (document.hidden || $('#workspace').hidden || document.querySelector('dialog[open]') || document.activeElement?.matches('input,textarea,select')) return; try { await load(); } catch { /* Reconnect on the next refresh. */ } }, 15000);
