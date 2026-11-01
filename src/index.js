import * as chrono from 'chrono-node';
import rrule from 'rrule';
import { DateTime } from 'luxon';
const { RRule } = rrule;

import { extractDate, parseClock } from './natural-date.js';
import { parseRecurrence } from './recurrence.js';

function instant(value, zone) {
  const d = value instanceof Date ? DateTime.fromJSDate(value, { zone }) : DateTime.fromISO(value, { zone });
  if (!d.isValid) throw new RangeError('Invalid date or timezone');
  return d;
}
function wallDate(d) { return new Date(Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second)); }
function fromWall(date, zone) {
  return DateTime.fromObject({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() }, { zone });
}
function due(d, allDay) { return { date: d.toISODate(), time: allDay ? null : d.toFormat('HH:mm'), timezone: d.zoneName, instant: allDay ? null : d.toUTC().toISO(), allDay }; }
function clean(text, spans) {
  let result = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) result = result.slice(0, s.start) + result.slice(s.end);
  return result.replace(/\s+/g, ' ').trim();
}
function mask(text, spans) {
  let result = text;
  for (const s of spans) result = result.slice(0, s.start) + ' '.repeat(s.end - s.start) + result.slice(s.end);
  return result;
}
function span(match, kind) { return { start: match.index, end: match.index + match[0].length, text: match[0], kind }; }

/** Parse a single task. now must be an ISO instant or Date; timezone is an IANA zone.
 * Numeric English dates use US order; Russian dates use day/month order.
 * Unsupported recurrence modifiers return needs_review without a partial schedule.
 */
export function parseTask(text, { now = new Date(), timezone = 'Europe/Moscow', language = 'auto', nextWeekDay = 1, weekendDay = 6, laterThisWeekDay = 5, dateOrder } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('Task text must not be empty');
  if (!['auto', 'en', 'ru'].includes(language)) throw new RangeError('language must be auto, en or ru');
  for (const value of [nextWeekDay, weekendDay, laterThisWeekDay]) if (!Number.isInteger(value) || value < 1 || value > 7) throw new RangeError('Weekday settings must be 1..7');
  if (dateOrder && !['DMY', 'MDY'].includes(dateOrder)) throw new RangeError('dateOrder must be DMY or MDY');
  const reference = instant(now, timezone);
  const locale = language === 'auto' ? (/[а-яё]/iu.test(text) ? 'ru' : 'en') : language;
  const base = { source: text, title: text.trim(), language: locale, status: 'unscheduled', due: null, recurrence: null, spans: [], warnings: [] };
  const review = message => ({ ...base, status: 'needs_review', warnings: [message] });
  const settings = { language: locale, nextWeekDay, weekendDay, laterThisWeekDay, dateOrder };
  const spans = [];
  // A deadline is independent of a task's changing scheduled date.
  const deadlines = [...text.matchAll(/\{([^{}]+)\}/gu)];
  if (deadlines.length > 1) return review('Only one deadline is supported');
  let deadline = null;
  if (deadlines.length) {
    const m = deadlines[0];
    const parsed = extractDate(m[1], reference, settings);
    if (!parsed?.date || !parsed.allDay || parsed.span.text !== m[1].trim()) return review('Invalid deadline');
    deadline = due(parsed.date, true);
    spans.push(span(m, 'deadline'));
  }
  const recurrenceResult = parseRecurrence(mask(text, spans), reference, settings);
  if (recurrenceResult?.error) return review(recurrenceResult.error);
  let recurrence = null;
  let options = null;
  if (recurrenceResult) {
    options = recurrenceResult.options;
    spans.push(...recurrenceResult.spans);
    recurrence = { mode: recurrenceResult.mode, frequency: ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY'][options.freq], interval: options.interval ?? 1, timezone };
  }
  const remainder = mask(text, spans);
  const natural = extractDate(remainder, reference, settings);
  if (natural?.error) return review(natural.error);
  const residual = natural?.span ? mask(remainder, [natural.span]) : remainder;
  if (/(?<![\p{L}\p{N}])(?:at|в|@)\s*\d{1,4}(?::\d{2})?(?![\p{L}\p{N}])/iu.test(residual)) return review('Unrecognized or conflicting time');
  if (natural?.clear) {
    if (recurrence) return review('Cannot combine a recurrence and no date');
    spans.push(natural.span);
    return { ...base, title: clean(text, spans), dateAction: 'clear', deadline, spans };
  }
  let date = reference.startOf('day');
  let allDay = true;
  let found = false;
  const warnings = [];
  if (natural?.date) {
    date = natural.date; allDay = natural.allDay; found = true;
    spans.push(natural.span); warnings.push(...natural.warnings);
  } else {
    const results = chrono[locale].parse(remainder, { instant: reference.toJSDate(), timezone: reference.offset }, { forwardDate: true });
    if (results.length > 1 || results.some(r => r.end)) return review('Multiple dates or date ranges need explicit selection');
    const parsed = results[0];
    if (parsed) {
      const c = parsed.start;
      allDay = !c.isCertain('hour');
      date = DateTime.fromObject({ year: c.get('year'), month: c.get('month'), day: c.get('day'), hour: allDay ? 0 : c.get('hour'), minute: allDay ? 0 : c.get('minute'), second: 0 }, { zone: timezone });
      if (!date.isValid) return review('Invalid date');
      if (c.isCertain('timezoneOffset')) return review('Inline timezones are not supported; use the timezone option');
      if (!allDay && date.hour !== c.get('hour')) return review('This local time does not exist because of a daylight-saving transition');
      spans.push({ start: parsed.index, end: parsed.index + parsed.text.length, text: text.slice(parsed.index, parsed.index + parsed.text.length), kind: 'date' });
      found = true;
    }
  }
  if (!found && /(?:\b(?:at|tomorrow|today)\b|(?<!\p{L})(?:завтра|сегодня|в)(?!\p{L}))\s*\d/iu.test(remainder)) return review('Date or time could not be parsed');
  if (!found && !recurrence) return { ...base, title: clean(text, spans), spans, deadline };
  if (recurrence) {
    // RRULE operates on wall-clock components in a synthetic UTC timeline.
    // Convert to real instants only at the API boundary, independent of host TZ.
    if (natural?.span && parseClock(natural.span.text)) date = reference.startOf('day').set({ hour: date.hour, minute: date.minute });
    if (options.freq >= RRule.HOURLY && !found && !recurrenceResult.start) { date = reference.set({ second: 0, millisecond: 0 }); allDay = false; }
    if (recurrenceResult.start) {
      const start = recurrenceResult.start;
      date = start.date.set(!allDay ? { hour: date.hour, minute: date.minute } : {});
      if (!start.allDay && allDay) allDay = false;
    }
    if (recurrenceResult.otherWeekday) {
      const wd = options.byweekday[0] + 1;
      date = date.plus({ days: ((wd - date.weekday + 7) % 7 || 7) + 7 });
    }
    const rule = new RRule({ ...options, ...(recurrenceResult.until ? { until: wallDate(recurrenceResult.until) } : {}), dtstart: wallDate(date) });
    const threshold = allDay ? reference.startOf('day') : reference;
    const first = rule.after(wallDate(threshold), true);
    if (!first) return review('No occurrence found');
    date = fromWall(first, timezone);
    recurrence = { ...recurrence, dtstart: date.toFormat("yyyy-MM-dd'T'HH:mm:ss"), rrule: rule.toString().split('\n').find(line => line.startsWith('RRULE:')) };
  }
  return { ...base, status: 'scheduled', title: clean(text, spans), due: due(date, allDay), recurrence, spans, deadline, warnings };
}

/** Return up to count future calendar occurrences, strictly after `after`.
 * After-completion rules require nextAfterCompletion instead.
 */
export function occurrences(task, { after = new Date(), count = 5 } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new RangeError('count must be 1..100');
  if (!task.recurrence || task.recurrence.mode !== 'calendar') throw new TypeError('Calendar recurrence required');
  const r = task.recurrence;
  const start = instant(r.dtstart, r.timezone);
  const rule = new RRule({ ...RRule.parseString(r.rrule), dtstart: wallDate(start) });
  const threshold = instant(after, r.timezone);
  let cursor = wallDate(threshold);
  const output = [];
  for (let attempts = 0; output.length < count && attempts < count + 370; attempts++) {
    const next = rule.after(cursor, false);
    if (!next) break;
    cursor = next;
    const local = fromWall(next, r.timezone);
    // Skip nonexistent DST wall times rather than silently shifting an occurrence.
    if (local.hour !== next.getUTCHours() || local.minute !== next.getUTCMinutes()) continue;
    if (local > threshold) output.push(due(local, task.due.allDay));
  }
  return output;
}

/** Calendar mode skips missed occurrences; completion mode advances from completion. */
export function nextAfterCompletion(task, completedAt) {
  if (!task.recurrence) return null;
  if (task.recurrence.mode === 'calendar') {
    const zone = task.recurrence.timezone;
    const completed = instant(completedAt, zone);
    const scheduled = instant(`${task.due.date}T${task.due.time ?? '00:00'}:00`, zone);
    return occurrences(task, { after: (completed > scheduled ? completed : scheduled).toISO(), count: 1 })[0] ?? null;
  }
  const r = task.recurrence;
  let next = instant(completedAt, r.timezone).plus({ [{ DAILY: 'days', WEEKLY: 'weeks', MONTHLY: 'months', YEARLY: 'years', HOURLY: 'hours', MINUTELY: 'minutes' }[r.frequency]]: r.interval });
  if (task.due.allDay) next = next.startOf('day');
  else if (!['HOURLY', 'MINUTELY'].includes(r.frequency)) { const [hour, minute] = task.due.time.split(':').map(Number); next = next.set({ hour, minute, second: 0, millisecond: 0 }); }
  const end = RRule.parseString(r.rrule).until;
  if (end && wallDate(next) > end) return null;
  return due(next, task.due.allDay);
}
