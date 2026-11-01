import rrule from 'rrule';
import { DAYS, weekday, extractDate, UNIT_PATTERN, unitName } from './natural-date.js';
const { RRule } = rrule;
const WD = `(?:${DAYS.join('|')})`;
const startBoundary = '(?<![\\p{L}\\p{N}])';
const endBoundary = '(?![\\p{L}\\p{N}])';
const prefix = '(?:every!?|ev!?|каждые!?|каждый!?|каждую!?|каждое!?)';
const span = (m, kind) => ({ start: m.index, end: m.index + m[0].length, text: m[0], kind });
const frequency = { days: RRule.DAILY, weeks: RRule.WEEKLY, months: RRule.MONTHLY, years: RRule.YEARLY, hours: RRule.HOURLY, minutes: RRule.MINUTELY };
export function parseRecurrence(text, ref, settings) {
  const patterns = [
    // Ordinal weekdays are monthly, not weekly intervals.
    [`${prefix}\\s+(\\d+)(?:st|nd|rd|th)?\\s+(${WD})`, m => ({ freq: RRule.MONTHLY, byweekday: [new rrule.Weekday(weekday(m[2]) - 1, +m[1])] })],
    [`${prefix}\\s+(?:other|вторую|второй)\\s+(${WD})`, m => ({ freq: RRule.WEEKLY, interval: 2, byweekday: [weekday(m[1]) - 1], otherWeekday: true })],
    [`${prefix}\\s+(${WD}(?:\\s*(?:,|and|и)\\s*${WD})*)`, m => ({ freq: RRule.WEEKLY, byweekday: m[1].split(/\s*(?:,|\band\b|\sи\s)\s*/u).map(x => weekday(x) - 1) })],
    [`${prefix}\\s+(?:weekdays?|workdays?|будни|рабочий день)`, () => ({ freq: RRule.WEEKLY, byweekday: [0, 1, 2, 3, 4] })],
    [`${prefix}\\s+(?:(\\d+|other)\\s+)?(${UNIT_PATTERN}|неделю|недели)`, m => ({ freq: frequency[unitName(m[2])], interval: m[1] === 'other' ? 2 : +(m[1] || 1) })],
    ['daily|everyday|ежедневно|ежедневный|weekly|еженедельно|еженедельный|monthly|ежемесячно|ежемесячный|yearly|ежегодно|ежегодный', m => ({ freq: /^(daily|everyday|ежеднев)/.test(m[0]) ? RRule.DAILY : /^(weekly|еженедель)/.test(m[0]) ? RRule.WEEKLY : /^(monthly|ежемесяч)/.test(m[0]) ? RRule.MONTHLY : RRule.YEARLY })],
  ];
  let match, options;
  for (const [pattern, make] of patterns) {
    const m = new RegExp(`${startBoundary}(?:${pattern})${endBoundary}`, 'iu').exec(text);
    if (m) { match = m; options = make(m); break; }
  }
  if (!match) {
    const annual = new RegExp(`${startBoundary}${prefix}\\s+((?:\\d{1,2}\\s+[\\p{L}.]+|[\\p{L}.]+\\s+\\d{1,2}))${endBoundary}`, 'iu').exec(text);
    if (annual) {
      const date = extractDate(annual[1], ref, settings);
      if (date?.date && date.span.text === annual[1]) {
        match = annual;
        options = { freq: RRule.YEARLY, bymonth: date.date.month, bymonthday: date.date.day };
      }
    }
  }
  if (!match) {
    if (new RegExp(`${startBoundary}${prefix}${endBoundary}`, 'iu').test(text)) return { error: 'Unsupported recurrence expression' };
    return null;
  }
  if (options.interval !== undefined && (!Number.isInteger(options.interval) || options.interval < 1 || options.interval > 1000)) return { error: 'Invalid recurrence interval' };
  if (options.byweekday?.some(d => typeof d !== 'number' && (d.n < 1 || d.n > 5))) return { error: 'Ordinal weekday must be 1..5' };
  const spans = [span(match, 'recurrence')];
  const completion = /(?:after completion|после выполнения)/iu.exec(text);
  if (completion) spans.push(span(completion, 'mode'));
  const mode = completion || match[0].includes('!') ? 'after_completion' : 'calendar';
  if (mode === 'after_completion' && options.byweekday) return { error: 'Completion-based weekdays are not supported' };
  let start = null, until = null;
  const markers = [...text.matchAll(/(?:starting(?: on)?|from|начиная с|ending(?: on)?|until|заканчивая(?: через)?|заканчивая|до)(?!\p{L})\s+/giu)].filter(m => m.index >= match.index + match[0].length);
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const offset = m.index + m[0].length;
    const end = markers[i + 1]?.index ?? text.length;
    let tail = text.slice(offset, end).trim();
    const isStart = /^(starting|from|начиная)/iu.test(m[0]);
    if (/через/iu.test(m[0])) tail = `через ${tail}`;
    const parsed = extractDate(tail, ref, settings);
    if (!parsed?.date || parsed.error || parsed.span.start !== 0) return { error: 'Invalid recurrence boundary' };
    const consumed = parsed.span.end - (/через/iu.test(m[0]) ? 6 : 0);
    spans.push({ start: m.index, end: offset + consumed, text: text.slice(m.index, offset + consumed), kind: isStart ? 'start' : 'until' });
    if (isStart) start = parsed;
    else until = parsed.date.endOf('day');
  }
  if (start && until && start.date > until) return { error: 'Recurrence ends before it starts' };
  let rest = text;
  for (const s of spans) rest = rest.slice(0, s.start) + ' '.repeat(s.end - s.start) + rest.slice(s.end);
  if (new RegExp(`${startBoundary}${prefix}${endBoundary}`, 'iu').test(rest) || /\b(?:except|until|starting|ending)\b|(?<!\p{L})(?:кроме|начиная|заканчивая)(?!\p{L})/iu.test(rest)) return { error: 'Unsupported recurrence modifier' };
  const otherWeekday = options.otherWeekday; delete options.otherWeekday;
  return { options, spans, mode, start, until, otherWeekday };
}
