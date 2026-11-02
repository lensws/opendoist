import { DateTime } from 'luxon';
import rrule from 'rrule';
import { entityFields, projectView } from './projects.js';
import { AppError } from './store.js';
const { RRule } = rrule;
export const IMPORT_LIMIT = 10 * 1024 * 1024;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const obj = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new AppError(400, `Не удалось импортировать: ${message}`); };
const str = (value, max = 1000) => typeof value === 'string' && value.length <= max;
const stamp = value => str(value, 40) && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && DateTime.fromISO(value).isValid;
const zone = value => str(value, 100) && DateTime.now().setZone(value).isValid;
function due(value, label) {
  if (value == null) return null;
  if (!obj(value) || !zone(value.timezone) || !str(value.date, 10) || !/^\d{4}-\d\d-\d\d$/.test(value.date) || typeof value.allDay !== 'boolean') fail(`некорректный срок (${label})`);
  const date = DateTime.fromISO(value.date, { zone: value.timezone });
  if (!date.isValid || date.toISODate() !== value.date) fail(`несуществующая дата (${label})`);
  if (value.allDay) {
    if (value.time != null || value.instant != null) fail(`некорректный срок без времени (${label})`);
  } else {
    if (!str(value.time, 5) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) || !stamp(value.instant)) fail(`некорректное время (${label})`);
    const instant = DateTime.fromISO(value.instant).setZone(value.timezone);
    if (instant.toISODate() !== value.date || instant.toFormat('HH:mm') !== value.time) fail(`время не соответствует часовому поясу (${label})`);
  }
  return { date: value.date, time: value.allDay ? null : value.time, timezone: value.timezone, instant: value.allDay ? null : value.instant, allDay: value.allDay };
}
function recurrence(value, schedule, label) {
  if (value == null) return null;
  const frequencies = ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY'];
  if (!obj(value) || !schedule || !['calendar', 'after_completion'].includes(value.mode) || !frequencies.includes(value.frequency) || !Number.isInteger(value.interval) || value.interval < 1 || value.interval > 1000 || value.timezone !== schedule.timezone || !str(value.dtstart, 19) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(value.dtstart) || !DateTime.fromISO(value.dtstart, { zone: value.timezone }).isValid || !str(value.rrule, 500) || !value.rrule.startsWith('RRULE:')) fail(`некорректное повторение (${label})`);
  const rules = value.rrules ?? [value.rrule];
  if (!Array.isArray(rules) || !rules.length || rules.length > 32 || rules[0] !== value.rrule || (rules.length > 1 && value.mode !== 'calendar')) fail(`некорректный список повторений (${label})`);
  for (const rule of rules) {
    if (!str(rule,500) || !rule.startsWith('RRULE:')) fail(`некорректное правило (${label})`);
    const parts = rule.slice(6).split(';');
    if (new Set(parts.map(p => p.split('=')[0])).size !== parts.length || parts.some(p => !/^(FREQ|INTERVAL|UNTIL|BYDAY|BYMONTH|BYMONTHDAY|BYSETPOS)=/.test(p))) fail(`неподдерживаемое правило повторения (${label})`);
    try {
      const options = RRule.parseString(rule);
      if (options.freq !== frequencies.indexOf(value.frequency) || (options.interval ?? 1) !== value.interval) throw Error();
      for (const [key, min, max] of [['bymonth',1,12], ['bymonthday',-1,31], ['bysetpos',-1,23]]) if (options[key] && [].concat(options[key]).some(v => !Number.isInteger(v) || v === 0 || v < min || v > max)) throw Error();
      if (options.byweekday && [].concat(options.byweekday).some(v => typeof v === 'number' ? v < 0 || v > 6 : v.weekday < 0 || v.weekday > 6 || (v.n != null && (v.n !== -1 && (v.n < 1 || v.n > 5))))) throw Error();
      if (options.until && !Number.isFinite(+options.until)) throw Error();
      new RRule({ ...options, dtstart: new Date(`${value.dtstart}Z`) });
    } catch { fail(`некорректное правило повторения (${label})`); }
  }
  if (value.businessInterval !== undefined) {
    const options=RRule.parseString(value.rrule);
    if (!Number.isInteger(value.businessInterval) || value.businessInterval < 1 || value.businessInterval > 1000 || value.mode !== 'calendar' || value.frequency !== 'DAILY' || value.interval !== 1 || rules.length !== 1 || options.bymonth || options.bymonthday || options.bysetpos || JSON.stringify(options.byweekday?.map(d => typeof d === 'number' ? d : d.n == null ? d.weekday : -1)) !== '[0,1,2,3,4]' || DateTime.fromISO(value.dtstart).weekday > 5) fail(`некорректный интервал рабочих дней (${label})`);
  }
  return { mode:value.mode, frequency:value.frequency, interval:value.interval, timezone:value.timezone, dtstart:value.dtstart, rrule:value.rrule,
    ...(value.rrules ? {rrules:rules} : {}), ...(value.businessInterval !== undefined ? {businessInterval:value.businessInterval} : {}) };

}
function task(value, label) {
  if (!obj(value) || !uuid(value.id) || !str(value.title, 500) || !value.title.trim() || !Number.isSafeInteger(value.revision) || value.revision < 1 || !stamp(value.createdAt) || !stamp(value.updatedAt) || (value.completedAt != null && !stamp(value.completedAt))) fail(`некорректная задача (${label})`);
  const result = { id: value.id.toLowerCase(), title: value.title, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt, completedAt: value.completedAt ?? null, due: due(value.due, label), deadline: due(value.deadline, label) };
  for (const key of ['projectId', 'sectionId', 'parentId']) { if (value[key] != null && !uuid(value[key])) fail(`некорректный проект или раздел (${label})`); result[key] = value[key]?.toLowerCase() || null; }
  if (value.description !== undefined && !str(value.description, 20000)) fail(`некорректное описание (${label})`);
  result.description = value.description || '';
  if (value.position !== undefined && !Number.isSafeInteger(value.position)) fail(`некорректный порядок (${label})`);
  if (value.position !== undefined) result.position = value.position;
  result.recurrence = recurrence(value.recurrence, result.due, label);
  result.status = result.due ? 'scheduled' : 'unscheduled';
  for (const key of ['source', 'language', 'dateAction']) if (value[key] !== undefined) { if (!str(value[key])) fail(`некорректное поле ${key} (${label})`); result[key] = value[key]; }
  result.spans = value.spans ?? []; result.warnings = value.warnings ?? [];
  if (!Array.isArray(result.spans) || result.spans.length > 100 || result.spans.some(s => !obj(s) || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end < s.start || !str(s.text) || !str(s.kind, 30)) || !Array.isArray(result.warnings) || result.warnings.length > 100 || result.warnings.some(w => !str(w))) fail(`некорректные метаданные (${label})`);
  result.spans = result.spans.map(({ start, end, text, kind }) => ({ start, end, text, kind }));
  const reminders = value.reminders ?? [];
  if (!Array.isArray(reminders) || reminders.length > 10 || new Set(reminders.map(r => r?.id)).size !== reminders.length) fail(`некорректные напоминания (${label})`);
  result.reminders = reminders.map(r => {
    if (!obj(r) || !uuid(r.id) || !Array.isArray(r.channels) || !r.channels.length || r.channels.length > 2 || new Set(r.channels).size !== r.channels.length || r.channels.some(c => !['email', 'telegram'].includes(c)) || !Number.isSafeInteger(r.createdAt) || r.createdAt < 0) fail(`некорректное напоминание (${label})`);
    const reminder = { id: r.id, channels: r.channels, kind: r.kind, createdAt: r.createdAt };
    if (r.kind === 'before' && Number.isInteger(r.minutes) && r.minutes >= 0 && r.minutes <= 525600) return { ...reminder, minutes: r.minutes };
    if (r.kind === 'absolute' && stamp(r.at) && zone(r.timezone)) return { ...reminder, at: r.at, timezone: r.timezone };
    fail(`некорректное время напоминания (${label})`);
  });
  return result;
}
export function validateImport(document) {
  if (!obj(document) || document.version !== 1 || !Array.isArray(document.tasks) || document.tasks.length > 10000 || !Array.isArray(document.history) || document.history.length > 10000) fail('ожидается JSON экспорта OpenDoist версии 1, не более 10 000 задач и 10 000 записей истории');
  const tasks = document.tasks.map((value, i) => task(value, `задача ${i + 1}`));
  const ids = new Set(tasks.map(t => t.id));
  if (ids.size !== tasks.length) fail('в файле повторяются ID задач');
  const history = document.history.map((value, i) => {
    if (!obj(value) || !stamp(value.completedAt)) fail(`некорректная история, запись ${i + 1}`);
    const snapshot = task(value.task, `история ${i + 1}`);
    if (!ids.has(snapshot.id)) fail(`история ссылается на отсутствующую задачу, запись ${i + 1}`);
    return { completedAt: value.completedAt, task: snapshot };
  });
  const entities = (items, section = false) => {
    if (!Array.isArray(items) || items.length > 10000) fail('некорректный список проектов или разделов');
    const result = items.map(e => {
      if (!obj(e) || !uuid(e.id) || !Number.isSafeInteger(e.revision) || e.revision < 1 || (section && !uuid(e.projectId))) fail('некорректный проект или раздел');
      return { id: e.id.toLowerCase(), ...entityFields(e), revision: e.revision, ...(section ? { projectId: e.projectId.toLowerCase() } : { view: projectView(e.view) }) };
    });
    if (new Set(result.map(e => e.id)).size !== result.length) fail('повторяются ID проектов или разделов');
    return result;
  };
  const projects = entities(document.projects || []), sections = entities(document.sections || [], true);
  const projectIds = new Set(projects.map(p => p.id));
  for (const section of sections) if (!projectIds.has(section.projectId)) fail('раздел ссылается на отсутствующий проект');
  for (const t of tasks) {
    if (t.projectId && !projectIds.has(t.projectId)) fail('задача ссылается на отсутствующий проект');
    if (t.sectionId && !sections.some(s => s.id === t.sectionId && s.projectId === t.projectId)) fail('раздел задачи не принадлежит её проекту');
  }
  for (const t of tasks) {
    let parentId = t.parentId, seen = new Set([t.id]);
    while (parentId) {
      if (seen.has(parentId) || seen.size > 10) fail('цикл или слишком большая вложенность задач');
      seen.add(parentId); const parent = tasks.find(p => p.id === parentId);
      if (!parent || parent.projectId !== t.projectId || parent.sectionId !== t.sectionId) fail('родительская задача отсутствует или находится в другом разделе');
      parentId = parent.parentId;
    }
  }
  // Historical snapshots can refer to a project that was deleted before export.
  for (const h of history) {
    if (!projectIds.has(h.task.projectId)) { h.task.projectId = null; h.task.sectionId = null; }
    if (!sections.some(s => s.id === h.task.sectionId && s.projectId === h.task.projectId)) h.task.sectionId = null;
  }
  return { tasks, history, projects, sections };
}
