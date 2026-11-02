// Todoist-style date grammar. All calculations use the supplied local calendar.
export const MONTHS = [
  'jan(?:uary)?|янв(?:арь|аря)?', 'feb(?:ruary)?|фев(?:раль|раля)?',
  'mar(?:ch)?|мар(?:т|та)?', 'apr(?:il)?|апр(?:ель|еля)?',
  'may|ма[йя]', 'jun(?:e)?|июн[ья]?', 'jul(?:y)?|июл[ья]?',
  'aug(?:ust)?|авг(?:уст|уста)?', 'sep(?:t(?:ember)?)?|сен(?:т(?:ябрь|ября)?)?',
  'oct(?:ober)?|окт(?:ябрь|ября)?', 'nov(?:ember)?|ноя(?:брь|бря)?',
  'dec(?:ember)?|дек(?:абрь|абря)?',
];
export const DAYS = ['mon(?:day)?|пн|понедельник', 'tue(?:s(?:day)?)?|вт|вторник', 'wed(?:nesday)?|ср|сред[ау]?', 'thu(?:rs(?:day)?)?|чт|четверг', 'fri(?:day)?|пт|пятниц[ау]', 'sat(?:urday)?|сб|суббот[ау]', 'sun(?:day)?|вс|воскресенье'];
export const weekday = text => DAYS.findIndex(p => new RegExp(`^(?:${p})$`, 'iu').test(text)) + 1;
export const month = text => MONTHS.findIndex(p => new RegExp(`^(?:${p})\\.?$`, 'iu').test(text)) + 1;
const upcoming = (d, day, strict = false) => d.plus({ days: (day - d.weekday + 7) % 7 || (strict ? 7 : 0) });
const unit = s => /^(day|д)/u.test(s) ? 'days' : /^(week|нед)/u.test(s) ? 'weeks' : /^(month|мес)/u.test(s) ? 'months' : /^(year|год|лет)/u.test(s) ? 'years' : /^(hour|час)/u.test(s) ? 'hours' : 'minutes';
export const unitName = unit;
const units = '(?:days?|день|дня|дней|weeks?|недел[яиюь]|недель|months?|месяц(?:а|ев)?|years?|год[а]?|лет|hours?|час(?:а|ов)?|minutes?|минут[ауы]?)';
export const UNIT_PATTERN = units;

function calendarDate(ref, y, m, d) {
  const date = ref.startOf('day').set({ year: y, month: m, day: d });
  return date.isValid && date.month === m && date.day === d ? date : null;
}
function annual(ref, m, d) {
  for (let y = ref.year; y <= ref.year + 8; y++) {
    const date = calendarDate(ref, y, m, d);
    if (date && date >= ref.startOf('day')) return date;
  }
  return null;
}
export function parseClock(text) {
  let s = text.trim().replace(/^(?:at\s+|в\s+|@\s*)/u, '');
  const parts = { 'утром': 9, 'утро': 9, 'in the morning': 9, 'morning': 9, 'днем': 12, 'днём': 12, 'in the afternoon': 12, 'afternoon': 12, 'noon': 12, 'полдень': 12, 'вечером': 19, 'вечер': 19, 'in the evening': 19, 'evening': 19, 'ночь': 22, 'ночью': 22, 'night': 22 };
  if (s in parts) return { hour: parts[s], minute: 0 };
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|утра|дня|вечера|ночи)?$/.exec(s);
  if (m) {
    let h = +m[1]; const min = +(m[2] || 0);
    if (h > 23 || min > 59 || (m[3] && (h < 1 || h > 12))) return null;
    if (m[3]) h = h % 12 + (/^(pm|дня|вечера)$/.test(m[3]) ? 12 : 0);
    else if (!m[2] && h >= 1 && h <= 7) h += 12;
    return { hour: h, minute: min };
  }
  if (/^\d{4}$/.test(s) && +s.slice(0, 2) <= 23 && +s.slice(2) <= 59) return { hour: +s.slice(0, 2), minute: +s.slice(2) };
  return null;
}

/** Exact grammar, no extraction. null means no match. */
export function exactDate(text, ref, settings = {}, depth = 0) {
  if (depth > 3) return null;
  const s = text.toLowerCase().trim();
  const day = ref.startOf('day');
  const result = (date, allDay = true, warnings = []) => date?.isValid ? { date, allDay, warnings } : null;
  let m;
  if (/^(?:без срока|нет срока|no (?:due )?date)$/.test(s)) return { clear: true };
  if (/^(?:сегодня|today|tod)$/.test(s)) return result(day);
  if (/^(?:завтра|tomorrow|tom)$/.test(s)) return result(day.plus({ days: 1 }));
  if (/^(?:послезавтра|day after tomorrow)$/.test(s)) return result(day.plus({ days: 2 }));
  if (/^(?:следующая неделя|на следующей неделе|next week)$/.test(s)) return result(upcoming(day, settings.nextWeekDay ?? 1, true));
  if (/^(?:следующий месяц|next month)$/.test(s)) return result(day.plus({ months: 1 }));
  if (/^(?:когда-нибудь|someday)$/.test(s)) return result(day.plus({ months: 2 }));
  if (/^(?:в следующем году|следующий год|next year)$/.test(s)) return result(day.plus({ years: 1 }).startOf('year'));
  if (/^(?:конец месяца|end of (?:the )?month)$/.test(s)) return result(day.endOf('month').startOf('day'));
  if (/^(?:на выходных|this weekend|следующие выходные|next weekend)$/.test(s)) return result(upcoming(day, settings.weekendDay ?? 6, true).plus({ weeks: /^(?:следующие|next)/.test(s) ? 1 : 0 }));
  if (/^(?:на этой неделе|later this week)$/.test(s)) {
    const target = settings.laterThisWeekDay ?? 5;
    const date = day.weekday < target ? day.set({ weekday: target }) : day.weekday < 7 ? day.set({ weekday: 7 }) : day.plus({ weeks: 1 });
    return result(date, true, ['later_this_week_policy: Friday, then Sunday; configurable. Todoist does not document an exact algorithm.']);
  }
  if (/^(?:следующий будний день|next weekday)$/.test(s)) return result(upcoming(day.plus({ days: 1 }), day.weekday >= 5 ? 1 : day.weekday + 1), true, ['literal_next_weekday_policy: next Monday-Friday day; the help table uses weekday as a placeholder.']);
  m = /^(?:next\s+|следующ(?:ий|ая|ую|ее)\s+)?(.+)$/.exec(s);
  const wd = weekday(m?.[1] || '');
  if (wd) return result(/^(next|следующ)/u.test(s) ? day.startOf('week').plus({ weeks: 1, days: wd - 1 }) : upcoming(day, wd, true));
  m = /^(?:mid\s+|середина\s+)(.+)$/.exec(s);
  if (m && month(m[1])) return result(annual(ref, month(m[1]), 15));
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(.+?)\s+(\S+)$/.exec(s);
  if (m && weekday(m[2]) && month(m[3])) {
    const n = +m[1]; if (n < 1 || n > 5) return null;
    for (let y = ref.year; y < ref.year + 8; y++) {
      const first = calendarDate(ref, y, month(m[3]), 1);
      const date = upcoming(first, weekday(m[2])).plus({ weeks: n - 1 });
      if (date.month === first.month && date >= day) return result(date);
    }
  }
  // Relative to another date, including holiday aliases used by the help page.
  m = new RegExp(`^(?:за\\s+)?(\\d+)\\s+(${units})\\s+(before|after|до|после)\\s+(.+)$`, 'u').exec(s);
  if (m) {
    const anchorText = /^(?:нового года|new year'?s? eve)$/.test(m[4]) ? '31 dec' : m[4];
    const anchor = exactDate(anchorText, ref, settings, depth + 1);
    if (anchor?.date) return result(anchor.date.plus({ [unit(m[2])]: +m[1] * (/^(before|до)$/.test(m[3]) ? -1 : 1) }), anchor.allDay);
  }
  m = new RegExp(`^(?:через\\s+|in\\s+|\\+\\s*)(\\d+)\\s*(${units})$`, 'u').exec(s);
  if (m) { const u = unit(m[2]); const timed = ['hours', 'minutes'].includes(u); return result((timed ? ref : day).plus({ [u]: +m[1] }), !timed); }
  m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return result(calendarDate(ref, +m[1], +m[2], +m[3]));
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}))?$/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2];
    const order = settings.dateOrder ?? (settings.language === 'en' ? 'MDY' : 'DMY');
    const dmy = a > 12 || (b <= 12 && order === 'DMY');
    const d = dmy ? a : b, mo = dmy ? b : a;
    return result(m[3] ? calendarDate(ref, +m[3], mo, d) : annual(ref, mo, d));
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([^\s]+)(?:\s+(\d{4}))?$/.exec(s);
  if (!m) { const reverse = /^([^\s]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(s); if (reverse) m = [reverse[0], reverse[2], reverse[1], reverse[3]]; }
  if (m && month(m[2])) return result(m[3] ? calendarDate(ref, +m[3], month(m[2]), +m[1]) : annual(ref, month(m[2]), +m[1]));
  if (/^(?:новый год|new year day|new year's day)$/.test(s)) return result(annual(ref, 1, 1));
  if (/^(?:канун нового года|new year eve|new year's eve)$/.test(s)) return result(annual(ref, 12, 31));
  if (/^(?:день (?:святого )?валентина|valentine|valentine[’']s day)$/.test(s)) return result(annual(ref, 2, 14));
  if (/^(?:хэллоуин|halloween)$/.test(s)) return result(annual(ref, 10, 31));
  // Bare date-field numbers: 1..12 denote an ambiguous hour, 13..31 a day.
  m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(s);
  if (m && (m[2] || +m[1] > 12)) return result(calendarDate(ref, ref.year, ref.month, +m[1]));
  const t = parseClock(s);
  if (t) {
    let date = day.set(t);
    if (date.hour !== t.hour) return { error: 'Nonexistent local time' };
    if (date <= ref) date = date.plus({ days: 1 });
    return result(date, false);
  }
  // Date + time, including compact English aliases such as tommorning.
  const compact = /^tom(morning|afternoon|evening|night)$/.exec(s);
  if (compact) return result(day.plus({ days: 1 }).set(parseClock(compact[1])), false);
  for (let i = s.indexOf(' '); i !== -1; i = s.indexOf(' ', i + 1)) {
    const clock = parseClock(s.slice(i + 1));
    if (!clock) continue;
    const date = exactDate(s.slice(0, i), ref, settings, depth + 1);
    if (date?.date && date.allDay) {
      const value = date.date.set(clock);
      return value.hour === clock.hour ? result(value, false, date.warnings) : { error: 'Nonexistent local time' };
    }
  }
  return null;
}

/** Find longest exact date phrases while preserving offsets in the original input. */
export function extractDate(text, ref, settings = {}) {
  const tokens = [...text.matchAll(/\S+/gu)];
  for (const token of tokens) {
    if (/^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[/.]\d{1,2}(?:[/.]\d{4})?)$/.test(token[0]) && !exactDate(token[0], ref, settings)) return { error: 'Invalid calendar date' };
  }
  const matches = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = tokens.length - 1; j >= i; j--) {
      const start = tokens[i].index, end = tokens[j].index + tokens[j][0].length;
      if (end - start > 150) continue;
      const phrase = text.slice(start, end);
      if (/^\d{1,4}$/.test(phrase) && text.trim() !== phrase) continue;
      const parsed = exactDate(phrase, ref, settings);
      if (parsed) { matches.push({ ...parsed, span: { start, end, text: phrase, kind: 'date' } }); break; }
    }
  }
  matches.sort((a, b) => (b.span.end - b.span.start) - (a.span.end - a.span.start));
  if (!matches.length) return null;
  const best = matches[0];
  if (matches.some(m => m.span.end <= best.span.start || m.span.start >= best.span.end)) return { error: 'Multiple dates need explicit selection' };
  return best;
}
