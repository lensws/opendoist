import { initMobileNavigation } from './mobile-navigation.js';
import { initGlobalSearch } from './global-search.js';
import { initNotes } from './notes.js';
import { fetchWorkspace } from './workspace-data.js';
import { orderedTree, compareTasks } from './task-tree.js';
import { markdown } from './markdown.js';
import { initTaskDetails } from './task-details.js';
import { initBackups } from './backups.js';
import { matchesSubmitShortcut } from './submit-shortcut.js';
import { initProjectViews } from './project-views.js';
import { initTaskInput } from './task-input.js';
import { initProjects } from './projects.js';
import { initTransfer } from './transfer.js';
import { initNotifications } from './notifications.js';
const $ = selector => document.querySelector(selector);
let tasks = [], history = [], projects = [], sections = [], view = 'inbox', preview = null, editTask = null, previewSequence = 0, timer, toastTimer;
let composerOpen = false;
let settings;
try { settings = JSON.parse(localStorage.getItem('opendoist.settings')) || {}; } catch { settings = {}; }
settings = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow', language: 'auto', ...settings, ...window.OpenDoistAppearance.normalize(settings) };
try { new Intl.DateTimeFormat('ru', { timeZone: settings.timezone }); } catch { settings.timezone = 'Europe/Moscow'; }
const titles = { notes:'Заметки', inbox: 'Входящие', all: 'Все задачи', today: 'Сегодня', upcoming: 'Предстоящие', completed: 'Выполненные', history: 'История' };
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/login') showLogin(); const error = new Error(data.error || 'Не удалось выполнить запрос'); error.status = response.status; throw error; }
  return data;
}
const mobileNavigation = initMobileNavigation();
const notesUI = initNotes({api,notify,onChange:()=>{if ($('#search').value.trim()) render();}});
initBackups({api});
const taskDetails = initTaskDetails({api, getTasks:() => tasks, reload:load, notify});
const projectUI = initProjects({ api, getData: () => ({ projects, sections, tasks }), reload: load, selectView: selectSearchView, notify });
const taskInput = initTaskInput({ getProjects: () => projects, chooseProject: id => projectUI.fillPlacement('add', id, '') });
const projectViews = initProjectViews({ api, reload:load, redraw:render, today:() => today(), getTimezone:() => settings.timezone, makeTaskRow, addTask:addInView, editTask:openEdit, completeTask, notify });
initTransfer({ api, reload: load, notify });
const { openReminders } = initNotifications({ api, reload: load, getSettings: () => settings, notify });
const globalSearch = initGlobalSearch({api,openTask:id=>{const task=tasks.find(t=>t.id===id);if(task)openEdit(task);else notify('Задача больше не доступна');},openNote:id=>notesUI.open(id),selectView:selectSearchView});
function selectSearchView(next) { mobileNavigation.close(); $('#search').value=''; view=next; render(); }
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
const todayCache = new Map();
function today(zone = settings.timezone) {
  if (!todayCache.has(zone)) {
    // Share the date during synchronous rendering, but never across midnight.
    queueMicrotask(() => todayCache.clear());
    todayCache.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
  }
  return todayCache.get(zone);
}
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
function showLogin() { mobileNavigation.close(false); globalSearch.hide(); notesUI.reset(); loadSequence++; $('#workspace').hidden = true; $('#login-screen').hidden = false; tasks = []; history = []; $('#task-list').replaceChildren(); for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); }
let loadSequence = 0;
async function load() {
  const sequence = ++loadSequence;
  const data = await fetchWorkspace(api, view === 'history');
  // A slower, older refresh must not overwrite a newer snapshot.
  if (sequence !== loadSequence) return;
  ({ settings, tasks, projects, sections } = data);
  if (data.history) history = data.history;
  window.OpenDoistAppearance.apply(settings);
  try { localStorage.setItem('opendoist.settings', JSON.stringify(settings)); } catch { /* Storage is optional. */ }
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
function formattedTitle(text) { const el = node('div', 'task-title markdown'); el.innerHTML = markdown(text); return el; }
function actionButton(label, symbol, handler, className = '') { const button = node('button', `icon-button ${className}`, symbol); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.addEventListener('click', handler); return button; }
function render() {
  todayCache.clear();
  $('#page-error').textContent = '';
  const entity = view.startsWith('project:') ? projects.find(p => p.id === view.slice(8)) : view.startsWith('section:') ? sections.find(s => s.id === view.slice(8)) : null;
  if (!titles[view] && !entity) view = 'inbox';
  $('#view-title').textContent = entity?.name || titles[view];
  $('#mobile-view-title').textContent = $('#search').value.trim() ? 'Поиск везде' : $('#view-title').textContent;
  projectUI.draw(view);
  if ($('#search').value.trim()) {
    projectViews.configure(null,'search'); notesUI.hide();
    $('#view-title').textContent='Поиск везде';
    for(const selector of ['#task-list','.list-toolbar','.page-footer','#empty']) $(selector).hidden=true;
    syncComposer();globalSearch.show($('#search').value.trim());return;
  }
  globalSearch.hide();
  const layout = projectViews.configure(view.startsWith('project:') ? entity : null, view, settings.views);
  $('#task-list').hidden = layout !== 'list' || view === 'notes';
  $('.list-toolbar').hidden = view === 'notes';
  $('.page-footer').hidden = view === 'notes';
  document.querySelectorAll('[data-view]').forEach(el => { const active = el.dataset.view === view; el.classList.toggle('active', active); if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  if (view === 'notes') { $('#empty').hidden=true; syncComposer(); notesUI.show($('#search').value); return; }
  notesUI.hide();
  const active = tasks.filter(t => !t.completedAt);
  const filters = { inbox: active.filter(t => !t.projectId), all: active, today: active.filter(t => t.due && t.due.date <= today(t.due.timezone)), upcoming: active.filter(t => t.due && t.due.date > today(t.due.timezone)), completed: tasks.filter(t => t.completedAt) };
  for (const key of Object.keys(filters)) { const counter = $(`#count-${key}`); if (counter) counter.textContent = filters[key].length; }
  $('#submit-hint').textContent = settings.submitShortcut === 'ctrl-enter' ? 'Ctrl/⌘ ↵' : '↵';
  const query = $('#search').value.trim().toLocaleLowerCase();
  const list = $('#task-list'); list.replaceChildren();
  $('#empty h2').textContent = query ? 'Ничего не найдено' : view === 'today' ? 'На сегодня всё' : view === 'completed' ? 'Первые победы впереди' : view === 'history' ? 'История пока пуста' : 'Здесь пока спокойно';
  $('#empty p').textContent = query ? 'Попробуйте другое название.' : view === 'today' ? 'Можно выдохнуть — или выбрать следующий шаг.' : ['completed', 'history', 'notes'].includes(view) ? 'Завершённые задачи появятся здесь.' : 'Добавьте задачу. Даже большой план начинается с маленького шага.';
  syncComposer();
  if (view === 'history') {
    const rows = history.filter(h => h.task.title.toLocaleLowerCase().includes(query));
    for (const item of rows) { const row = node('article', 'task done'); row.append(node('span', 'task-check', '✓')); const content = node('div', 'task-main'); content.append(formattedTitle(item.task.title), meta(item.task), node('div', 'task-meta', `Выполнено ${new Date(item.completedAt).toLocaleString('ru', { timeZone: settings.timezone })}`)); row.append(content); list.append(row); }
    $('#task-summary').textContent = `Выполнений: ${rows.length}`; $('#empty').hidden = !!rows.length; return;
  }
  let selected = (entity ? active.filter(t => view.startsWith('project:') ? t.projectId === entity.id : t.sectionId === entity.id) : filters[view]).filter(t => `${t.title} ${t.description || ''}`.toLocaleLowerCase().includes(query)).sort((a, b) => (view.startsWith('project:') ? sections.findIndex(s => s.id === a.sectionId) - sections.findIndex(s => s.id === b.sectionId) : 0) || (a.due?.date || '9999').localeCompare(b.due?.date || '9999') || (a.due?.time || '').localeCompare(b.due?.time || '') || b.createdAt.localeCompare(a.createdAt));
  const manual = !!entity || view === 'inbox';
  if (manual) selected.sort((a,b) => sections.findIndex(s => s.id === a.sectionId) - sections.findIndex(s => s.id === b.sectionId) || compareTasks(a,b));
  $('#task-summary').textContent = `Задач: ${selected.length}`; $('#empty').hidden = !!selected.length;
  if (layout !== 'list') { $('#empty').hidden = true; projectViews.draw(selected, sections.filter(s => s.projectId === entity?.id)); return; }
  let lastGroup;
  const tree = manual ? orderedTree(selected, (a,b) => sections.findIndex(s => s.id === a.sectionId) - sections.findIndex(s => s.id === b.sectionId) || compareTasks(a,b)) : selected.map(task => ({task, depth:0}));
  const treeTasks = tree.map(e => e.task);
  for (const {task, depth} of tree) {
    const group = manual ? sections.find(s => s.id === task.sectionId)?.name || 'Без раздела' : task.completedAt ? 'Готово' : overdue(task) ? 'Просрочено' : task.due ? dateLabel({ ...task.due, time: null }) : 'Без срока';
    if (group !== lastGroup) { list.append(node('h2', 'group-heading', group)); lastGroup = group; }
    const row = makeTaskRow(task);
    if (manual && !query) taskDetails.decorate(row, task, depth, treeTasks);
    list.append(row);
  }
}
async function completeTask(task, check) {
      check.disabled = true;
      try { const result = await api(`/tasks/${task.id}/${task.completedAt ? 'undo' : 'complete'}`, { method: 'POST', body: { revision: task.revision } }); await load(); notify(task.completedAt ? 'Задача возвращена' : result.task.completedAt ? 'Готово. Ещё один шаг!' : `Следующий срок: ${dateLabel(result.task.due)}`, task.completedAt ? null : async () => { await api(`/tasks/${task.id}/undo`, { method: 'POST', body: { revision: result.task.revision } }); await load(); }); }
      catch (e) { $('#page-error').textContent = e.message; check.disabled = false; }
}
function makeTaskRow(task) {
    const row = node('article', `task${task.completedAt ? ' done' : ''}`);
    const check = node('button', 'task-check', task.completedAt ? '✓' : ''); check.type = 'button'; check.title = task.completedAt ? 'Отменить выполнение' : 'Выполнить задачу'; check.setAttribute('aria-label', `${check.title}: ${task.title}`);
    check.addEventListener('click', () => completeTask(task, check));
    const content = node('div', 'task-main'); const title = node('div', 'task-title markdown'); title.innerHTML = markdown(task.title); title.addEventListener('dblclick', () => openEdit(task)); content.append(title, meta(task));
    if (task.description) { const description = node('div', 'task-description markdown'); description.innerHTML = markdown(task.description, true); content.append(description); }
    const actions = node('div', 'task-actions');
    if (!task.completedAt) {
      const reminder = actionButton(task.reminders?.length ? `Напомнить (${task.reminders.length})` : 'Напомнить', '', () => openReminders(task), 'reminder-action');
      reminder.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
      actions.append(reminder);
    }
    actions.append(actionButton('Открыть задачу', '✎', () => openEdit(task)));
    actions.append(actionButton('Удалить задачу', '×', async () => {
      if (!confirm(`Удалить «${task.title}» и историю её выполнений? Дочерние задачи сохранятся.`)) return;
      try { await api(`/tasks/${task.id}`, { method: 'DELETE', body: { revision: task.revision } }); await load(); notify('Задача удалена'); } catch (e) { $('#page-error').textContent = e.message; }
    }, 'delete'));
    row.append(check, content, actions); return row;
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
  const sequence = ++previewSequence; preview = null; $('#add-submit').disabled = true; $('#add-without-schedule').hidden = true; $('#add-without-schedule').disabled = false;
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
    el.className = `preview ${valid ? 'ready' : 'error'}`; $('#add-submit').disabled = !valid; $('#add-without-schedule').hidden = valid;
  } catch (e) { if (sequence === previewSequence) { el.className = 'preview error'; el.textContent = e.message; $('#add-without-schedule').hidden = false; } }
}
$('#task-input').addEventListener('input', () => { previewSequence++; preview = null; $('#add-submit').disabled = true; $('#add-without-schedule').hidden = true; clearTimeout(timer); timer = setTimeout(refreshPreview, 250); });
$('#task-input').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return;
  const submit = matchesSubmitShortcut(event, settings.submitShortcut);
  event.preventDefault();
  if (submit && !$('#add-submit').disabled) $('#add-form').requestSubmit($('#add-submit'));
});
$('#add-form').addEventListener('submit', async event => {
  event.preventDefault();
  const withoutSchedule = event.submitter === $('#add-without-schedule'), source = $('#task-input').value.trim();
  if (!source || (!withoutSchedule && (!preview || preview.source !== source))) return;
  $('#add-submit').disabled = true; $('#add-without-schedule').disabled = true;
  try { await api('/tasks', { method: 'POST', body: { source, reference: preview?.reference, ...settings, withoutSchedule, ...projectUI.placement('add') } }); $('#task-input').value = ''; await refreshPreview(); composerOpen = false; await load(); $('#add-open').focus(); notify('Задача добавлена'); }
  catch (e) { $('#page-error').textContent = e.message; $('#add-submit').disabled = withoutSchedule; $('#add-without-schedule').disabled = false; }
});
document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', async () => { $('#search').value=''; view = el.dataset.view; if ($('#settings-dialog').open) $('#settings-dialog').close(); render(); try { if (view === 'history') await load(); } catch (e) { $('#page-error').textContent = e.message; } }));
$('#search').addEventListener('input', render);
$('#search').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();$('#search').value='';render();$('#search').blur();}});
document.addEventListener('keydown',event=>{
  if(event.isComposing || event.altKey || event.shiftKey || $('#workspace').hidden || document.querySelector('dialog[open]'))return;
  if((event.ctrlKey || event.metaKey) && event.code==='KeyK'){
    event.preventDefault();mobileNavigation.open();$('#search').focus();$('#search').select();
  }
});
function syncComposer() {
  const unavailable = !!$('#search').value.trim() || ['completed', 'history', 'notes'].includes(view);
  $('#add-form').hidden = unavailable || !composerOpen;
  $('#add-open').hidden = unavailable || composerOpen;
  $('#add-open').setAttribute('aria-expanded', String(composerOpen && !unavailable));
}
function focusAdd() { if ($('#search').value) { $('#search').value=''; render(); } if (['completed', 'history', 'notes'].includes(view)) { view = 'inbox'; render(); } composerOpen = true; syncComposer(); $('#task-input').focus(); }
function addInView({ projectId, sectionId = null, date = null, time = null }) {
  if ($('#task-input').value.trim()) { focusAdd(); notify('В форме есть черновик. Добавьте его или очистите текст.'); return; }
  projectUI.fillPlacement('add', projectId, sectionId); focusAdd();
  if (date) { $('#task-input').value = ` ${date}${time ? ` ${time}` : ''}`; $('#task-input').setSelectionRange(0, 0); $('#task-input').dispatchEvent(new Event('input', { bubbles:true })); }
}
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
function openEdit(task) { editTask = task; projectUI.fillPlacement('edit', task.projectId, task.sectionId); $('#edit-title').value = task.title; taskDetails.open(task); $('#edit-schedule').value = ''; $('#edit-clear').checked = false; $('#edit-preview').textContent = `Текущий срок: ${dateLabel(task.due)}${task.recurrence ? ` · ${recurringLabel(task)}` : ''}`; $('#edit-error').textContent = ''; $('#edit-dialog').showModal(); }
let editTimer, editSequence = 0;
$('#edit-schedule').addEventListener('input', () => {
  clearTimeout(editTimer); const sequence = ++editSequence;
  editTimer = setTimeout(async () => { if (!$('#edit-schedule').value.trim()) { $('#edit-preview').textContent = 'Текущее расписание сохранится.'; return; } try { const result = await api('/parse', { method: 'POST', body: { source: `Task ${$('#edit-schedule').value}`, ...settings, timezone: editTask.due?.timezone || settings.timezone } }); if (sequence === editSequence) $('#edit-preview').textContent = previewText(result); } catch (e) { if (sequence === editSequence) $('#edit-preview').textContent = e.message; } }, 250);
});
$('#edit-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const body = { title: $('#edit-title').value.trim(), description: $('#edit-description').value, revision: editTask.revision, clearSchedule: $('#edit-clear').checked, ...projectUI.placement('edit') };
  const expression = $('#edit-schedule').value.trim();
  if (expression && !body.clearSchedule) { body.source = `Task ${expression}`; Object.assign(body, settings, { timezone: editTask.due?.timezone || settings.timezone }); }
  try { const result = await api(`/tasks/${editTask.id}`, { method: 'PATCH', body }); editTask = result.task; await taskDetails.saveParent(editTask, editTask.parentId); $('#edit-dialog').close(); await load(); notify('Изменения сохранены'); }
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
  $('#submit-shortcut').value = settings.submitShortcut || 'enter';
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
  const next = { ...settings, submitShortcut: $('#submit-shortcut').value, timezone, language: $('#language').value, ...appearanceDraft() };
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

setInterval(async () => { if (document.querySelector('.dragging') || document.hidden || $('#workspace').hidden || document.querySelector('dialog[open]') || document.activeElement?.matches('input,textarea,select')) return; try { await load(); } catch { /* Reconnect on the next refresh. */ } }, 15000);
