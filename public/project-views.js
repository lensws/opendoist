import { markdown } from './markdown.js';
import { calendarRange, nextAnchor, calendarTaskDate, calendarClock } from './calendar-model.js';
const node = (tag, cls = '', text = '') => { const el = document.createElement(tag); el.className = cls; el.textContent = text; return el; };
const button = (text, label, action, cls = 'secondary') => { const el = node('button', cls, text); el.type = 'button'; el.setAttribute('aria-label', label); el.addEventListener('click', action); return el; };
const dateLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('ru', { day:'numeric', month:'long', timeZone:'UTC' });
export function initProjectViews({ api, reload, redraw, today, getTimezone, makeTaskRow, addTask, editTask, completeTask, notify }) {
  const controls = document.querySelector('#project-view-controls'), layout = document.querySelector('#project-layout'), scale = document.querySelector('#calendar-scale');
  const host = document.querySelector('#project-view');
  const scrollPositions = new Map();
  let currentView = null, selectedLayout = 'list';
  let currentProject = null, anchor = null, dragged = null, saving = false;
  function updateCurrentTime() {
    host.querySelectorAll('.current-time-line,.current-time-label').forEach(el => el.remove());
    if (host.hidden) return;
    const now = calendarClock(getTimezone());
    host.querySelectorAll('[data-calendar-date]').forEach(el => el.classList.toggle('calendar-today', el.dataset.calendarDate === now.date));
    const grid = host.querySelector('.time-grid');
    if (!grid || ![...grid.querySelectorAll('[data-calendar-date]')].some(el => el.dataset.calendarDate === now.date)) return;
    for (const cell of grid.querySelectorAll(`[data-hour="${now.hour}"]`)) {
      const isLabel = cell.classList.contains('calendar-hour');
      const line = node('div', isLabel ? 'current-time-label' : `current-time-line${cell.dataset.calendarDate === now.date ? ' current-day-line' : ''}`, isLabel ? now.time : '');
      line.style.top = `${now.fraction * 100}%`; line.setAttribute('aria-hidden', 'true'); cell.append(line);
    }
  }
  setInterval(updateCurrentTime, 30000);
  async function changeView(mode = selectedLayout) {
    if ((!currentProject && !currentView) || saving) return;
    const project = currentProject; saving = true; layout.disabled = scale.disabled = true;
    try {
      const preference = { layout:mode, calendar:currentView === 'today' ? 'day' : scale.value };
      if (project) await api(`/projects/${project.id}/view`, { method:'PATCH', body:{ revision:project.revision, view:preference } });
      else await api('/settings', {method:'PATCH', body:{views:{[currentView]:preference}}});
      await reload();
    }
    catch (error) { notify(error.message); await reload(); }
    finally { saving = false; layout.disabled = scale.disabled = false; }
  }
  layout.querySelectorAll('[data-layout]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.layout !== selectedLayout) changeView(button.dataset.layout);
  }));
  scale.addEventListener('change', () => changeView());
  function configure(project, view, preferences = {}) {
    const builtIn = ['inbox', 'today', 'upcoming'].includes(view) ? view : null;
    if (project?.id !== currentProject?.id || builtIn !== currentView) anchor = today();
    currentProject = project; currentView = builtIn;
    if (builtIn === 'today') anchor = today();
    controls.hidden = !project && !builtIn; host.hidden = true; host.replaceChildren();
    const preference = project?.view || preferences[builtIn];
    const mode = preference?.layout || 'list';
    selectedLayout = mode;
    layout.querySelectorAll('[data-layout]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layout === mode)));
    scale.value = builtIn === 'today' ? 'day' : preference?.calendar || 'month';
    scale.querySelector('[value="day"]').hidden = !!project;
    scale.querySelector('[value="day"]').disabled = !!project;
    scale.hidden = mode !== 'calendar' || builtIn === 'today';
    document.querySelector('.content').classList.toggle('wide-view', !!(project || builtIn) && mode !== 'list');
    return mode;
  }
  async function move(task, patch, schedule = false) {
    if (saving) return; saving = true; layout.disabled = scale.disabled = true;
    host.querySelectorAll('.board-move').forEach(select => select.disabled = true);
    try {
      await api(`/tasks/${task.id}${schedule ? '/reschedule' : ''}`, { method:schedule ? 'POST' : 'PATCH', body:{ revision:task.revision, ...(schedule ? { timezone:getTimezone() } : { title:task.title }), ...patch } });
      await reload(); notify(schedule ? (task.recurrence ? 'Ближайший срок перенесён. Повторение сохранено.' : 'Срок изменён') : 'Задача перемещена');
    } catch (error) { notify(error.message); await reload(); }
    finally { saving = false; layout.disabled = scale.disabled = false; }
  }
  function draggable(row, task) {
    row.draggable = true;
    row.addEventListener('dragstart', event => { dragged = task; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { dragged = null; row.classList.remove('dragging'); host.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target')); });
  }
  function dropZone(el, action) {
    el.addEventListener('dragover', event => { if (!dragged) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; el.classList.add('drop-target'); });
    el.addEventListener('dragleave', event => { if (!el.contains(event.relatedTarget)) el.classList.remove('drop-target'); });
    el.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); el.classList.remove('drop-target'); const task = dragged; dragged = null; if (task) action(task); });
  }
  function globalBoard(tasks) {
    const board = node('div', 'project-board');
    const dated = tasks.map(task => ({task, date:calendarTaskDate(task, getTimezone())?.date || null}));
    const dates = [...new Set([today(), ...dated.map(e => e.date).filter(Boolean)])].sort();
    for (const date of [...dates, null]) {
      const entries = dated.filter(e => e.date === date).map(e => e.task);
      if (!entries.length && currentView !== 'inbox' && date !== today()) continue;
      const name = date === null ? 'Без срока' : date === today() ? 'Сегодня' : dateLabel(date);
      const column = node('section', 'board-column'); column.setAttribute('aria-label', name);
      column.append(node('h2', 'board-heading', `${name} · ${entries.length}`));
      dropZone(column, task => move(task, {date}, true));
      for (const task of entries) { const row = makeTaskRow(task); row.classList.add('board-card'); draggable(row, task); column.append(row); }
      column.append(button('＋ Добавить задачу', `Добавить задачу: ${name}`, () => addTask({projectId:null, date}), 'add-inline'));
      board.append(column);
    }
    host.append(board);
  }
  function board(tasks, sections) {
    const board = node('div', 'project-board');
    for (const section of [{ id:null, name:'Без раздела' }, ...sections]) {
      const column = node('section', 'board-column'), entries = tasks.filter(t => (t.sectionId || null) === section.id);
      column.setAttribute('aria-label', section.name);
      column.append(node('h2', 'board-heading', `${section.emoji || ''} ${section.name} · ${entries.length}`));
      dropZone(column, task => { if (task.sectionId !== section.id) move(task, { projectId:currentProject.id, sectionId:section.id }); });
      for (const task of entries) {
        const row = makeTaskRow(task); row.classList.add('board-card'); draggable(row, task);
        const select = document.createElement('select'); select.className = 'board-move'; select.setAttribute('aria-label', `Раздел задачи ${task.title}`);
        for (const dest of [{id:'',name:'Без раздела'}, ...sections]) select.add(new Option(dest.name, dest.id));
        select.value = task.sectionId || ''; select.addEventListener('change', () => move(task, { projectId:currentProject.id, sectionId:select.value || null }));
        row.append(select); column.append(row);
      }
      column.append(button('＋ Добавить задачу', `Добавить задачу в ${section.name}`, () => addTask({projectId:currentProject.id, sectionId:section.id}), 'add-inline'));
      board.append(column);
    }
    host.append(board);
  }
  function calendarCard(task, projected) {
    const card = node('article', 'calendar-card'); draggable(card, task);
    const title = `${projected?.time ? projected.time + ' · ' : ''}${task.recurrence ? '↻ ' : ''}${task.title}`;
    const check = button('○', `Выполнить задачу: ${task.title}`, () => completeTask(task, check), 'calendar-complete'); card.append(check);
    const titleButton = button(title, `Редактировать задачу ${task.title}`, () => editTask(task), 'calendar-task-title'); titleButton.innerHTML = markdown(title); card.append(titleButton);
    // Full editor also offers date and project changes for touch and keyboard users.
    card.title = title + (task.recurrence ? ' (ближайшее повторение)' : '');
    return card;
  }
  function calendar(tasks) {
    const mode = currentView === 'today' ? 'day' : scale.value, dates = calendarRange(anchor, mode), timezone = getTimezone();
    const toolbar = node('div', 'calendar-toolbar');
    const heading = mode === 'day' ? dateLabel(dates[0]) : mode === 'month' ? new Date(`${anchor}T12:00:00Z`).toLocaleDateString('ru', {month:'long',year:'numeric',timeZone:'UTC'}) : `${dateLabel(dates[0])} — ${dateLabel(dates.at(-1))}`;
    toolbar.append(button('‹', 'Предыдущий период', () => { anchor = nextAnchor(anchor, mode, -1); redraw(); }), node('h2', '', heading), button('›', 'Следующий период', () => { anchor = nextAnchor(anchor, mode, 1); redraw(); }), button('Сегодня', 'Перейти к сегодняшнему дню', () => { anchor = today(); redraw(); }));
    const dateInput = document.createElement('input'); dateInput.type = 'date'; dateInput.value = anchor; dateInput.setAttribute('aria-label','Перейти к дате'); dateInput.addEventListener('change', () => { if (/^\d{4}-\d\d-\d\d$/.test(dateInput.value)) { anchor=dateInput.value; redraw(); } }); toolbar.append(dateInput);
    if (currentView === 'today') toolbar.replaceChildren(node('h2', '', heading));
    host.append(toolbar, node('p', 'muted small', `Часовой пояс: ${timezone}. Повторяющиеся задачи показывают ближайший срок.`));
    const projected = tasks.filter(t => t.due).map(task => ({ task, date:calendarTaskDate(task, timezone) })).sort((a,b) => a.date.date.localeCompare(b.date.date) || (a.date.time || '').localeCompare(b.date.time || ''));
    if (currentView === 'today') {
      const overdue = projected.filter(e => e.date.date < today());
      if (overdue.length) {
        const panel = node('section', 'calendar-unscheduled'); panel.append(node('h2', 'board-heading', `Просрочено · ${overdue.length}`));
        for (const entry of overdue) panel.append(calendarCard(entry.task, entry.date));
        host.append(panel);
      }
    }
    const wrap = node('div', 'calendar-scroll'), grid = node('div', `calendar-grid ${mode === 'month' ? 'month-grid' : 'time-grid'}`);
    if (mode === 'day') grid.classList.add('one-day');
    if (mode === 'three-days') grid.classList.add('three-days');
    if (mode !== 'month') grid.append(node('div','calendar-day-heading','Время'));
    const headers = mode === 'month' ? dates.slice(0,7) : dates;
    for (const date of headers) grid.append(node('div', 'calendar-day-heading', new Date(`${date}T12:00:00Z`).toLocaleDateString('ru', {weekday:'short', ...(mode === 'month' ? {} : {day:'numeric',month:'short'}), timeZone:'UTC'})));
    function cell(date, time, entries, month = false) {
      const el = node('div', `calendar-cell${date === today() ? ' calendar-today' : ''}${month && date.slice(0,7) !== anchor.slice(0,7) ? ' other-month' : ''}`);
      el.dataset.calendarDate = date; if (time) el.dataset.hour = String(Number(time.slice(0,2)));
      el.setAttribute('aria-label', `${dateLabel(date)}${time ? ' '+time : ''}`);
      const add = button(month ? String(Number(date.slice(-2))) : '＋', `Добавить задачу ${date}${time ? ' в '+time : ''}`, () => addTask({ projectId:currentProject?.id || null, date, time }), 'calendar-add');
      el.append(add);
      for (const entry of entries) el.append(calendarCard(entry.task, entry.date));
      dropZone(el, task => move(task, { date, time:month ? calendarTaskDate(task, timezone)?.time ?? null : time }, true));
      return el;
    }
    if (mode === 'month') {
      for (const date of dates) grid.append(cell(date, null, projected.filter(e => e.date.date === date).sort((a,b) => (a.date.time || '').localeCompare(b.date.time || '')), true));
    } else {
      grid.append(node('div','calendar-hour calendar-all-day','Весь день'));
      for (const date of dates) { const allDay = cell(date, null, projected.filter(e => e.date.date === date && !e.date.time)); allDay.classList.add('calendar-all-day'); grid.append(allDay); }
      for (let hour=0; hour<24; hour++) {
        const time = `${String(hour).padStart(2,'0')}:00`; const hourLabel = node('div','calendar-hour',time); hourLabel.dataset.hour = String(hour); grid.append(hourLabel);
        for (const date of dates) grid.append(cell(date, time, projected.filter(e => e.date.date === date && Number(e.date.time?.slice(0,2)) === hour)));
      }
    }
    wrap.append(grid); host.append(wrap);
    const scrollKey = `${currentProject?.id || currentView}:${mode}:${dates[0]}`;
    const restoreScroll = scrollPositions.get(scrollKey);
    if (restoreScroll !== undefined) wrap.scrollTop = restoreScroll;
    else if (mode !== 'month') { const now = calendarClock(timezone); const firstHour = grid.querySelectorAll('.calendar-hour')[dates.includes(now.date) ? Math.max(1, now.hour) : 9]; if (firstHour) wrap.scrollTop = firstHour.offsetTop - grid.offsetTop - 40 - (mode === 'day' ? grid.querySelector('.calendar-all-day').offsetHeight : 0); }
    updateCurrentTime();
    wrap.addEventListener('scroll', () => { if (scrollPositions.size > 30) scrollPositions.delete(scrollPositions.keys().next().value); scrollPositions.set(scrollKey, wrap.scrollTop); });
    const unscheduled = node('section', 'calendar-unscheduled'); unscheduled.setAttribute('aria-label','Задачи без срока');
    const pending = tasks.filter(t => !t.due); unscheduled.append(node('h2','board-heading',`Без срока · ${pending.length}`));
    for (const task of pending) unscheduled.append(calendarCard(task, null));
    if (!pending.length) unscheduled.append(node('p','muted small','Перетащите сюда задачу, чтобы убрать срок.'));
    dropZone(unscheduled, task => move(task, { date:null }, true)); host.append(unscheduled);
  }
  function draw(tasks, sections) { host.hidden = false; if (selectedLayout === 'board') { if (currentProject) board(tasks, sections); else globalBoard(tasks); } else calendar(tasks); }
  return { configure, draw };
}
