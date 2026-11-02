import rrule from 'rrule';
import { DAYS, MONTHS, month, weekday, extractDate, parseClock, UNIT_PATTERN, unitName } from './natural-date.js';
const { RRule } = rrule;
const WD = `(?:${DAYS.join('|')})`;
const MO = `(?:${MONTHS.join('|')})\\.?`;
const left = '(?<![\\p{L}\\p{N}])', right = '(?![\\p{L}\\p{N}])';
const prefix = '(?:every!?|ev!?|каждые!?|каждый!?|каждую!?|каждое!?|каждая!?|кажд!?)';
const ordinal = '(?:\\d+(?:st|nd|rd|th|-?[еийяю])?|first|last|перв(?:ый|ую|ое)|последн(?:ий|юю|ее))';
const workday = '(?:workdays?|weekdays?|рабочи[йех] д(?:ень|ня|ней))';
const separator = '\\s*(?:,\\s*(?:(?:and|и)\\s+)?|\\s+(?:and|и)\\s+)';
const weekdays = [0, 1, 2, 3, 4];
const frequency = { days:RRule.DAILY, weeks:RRule.WEEKLY, months:RRule.MONTHLY, years:RRule.YEARLY, hours:RRule.HOURLY, minutes:RRule.MINUTELY };
const position = s => /^(last|последн)/iu.test(s) ? -1 : /^(first|перв)/iu.test(s) ? 1 : parseInt(s, 10);
const span = (m, kind) => ({start:m.index, end:m.index + m[0].length, text:m[0], kind});
const rx = pattern => new RegExp(`${left}(?:${pattern})${right}`, 'iu');
const all = (text, pattern) => [...text.matchAll(new RegExp(pattern, 'giu'))];

export function parseRecurrence(text, ref, settings) {
  const annualDay = `(?:\\d{1,2}(?:st|nd|rd|th)?\\s+${MO}|${MO}\\s+\\d{1,2}(?:st|nd|rd|th)?)`;
  const annualWeekday = `${ordinal}\\s+${WD}\\s+(?:(?:of|in)\\s+)?${MO}`;
  const workingPosition = `${ordinal}\\s+${workday}`;
  const monthlyDay = '\\d{1,2}(?:st|nd|rd|th|-?е)?(?:\\s+(?:число|day))?';
  const patterns = [
    // Each annual pair is a separate rule: combining BYMONTH and BYMONTHDAY would create a Cartesian product.
    [`${prefix}\\s+(${annualWeekday}(?:${separator}${annualWeekday})*)`, m => ({rules:all(m[1], `(${ordinal})\\s+(${WD})\\s+(?:(?:of|in)\\s+)?(${MO})`).map(p => ({freq:RRule.YEARLY, bymonth:month(p[3]), byweekday:[new rrule.Weekday(weekday(p[2])-1, position(p[1]))]}))})],
    [`${prefix}\\s+(${annualDay}(?:${separator}${annualDay})*)`, m => ({rules:all(m[1], annualDay).map(p => {
      const numericFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+(.+)$/iu.exec(p[0]);
      const reverse = /^(.+?)\s+(\d{1,2})(?:st|nd|rd|th)?$/iu.exec(p[0]);
      return {freq:RRule.YEARLY, bymonth:month(numericFirst ? numericFirst[2] : reverse[1]), bymonthday:Number(numericFirst ? numericFirst[1] : reverse[2])};
    })})],
    [`${prefix}\\s+(${workingPosition}(?:${separator}${workingPosition})+)`, m => ({freq:RRule.MONTHLY, byweekday:weekdays, bysetpos:all(m[1], `(${ordinal})\\s+${workday}`).map(p => position(p[1]))})],
    [`${prefix}\\s+(first|last|перв(?:ый|ую|ое)|последн(?:ий|юю|ее)|\\d+(?:st|nd|rd|th|-?[йе]))\\s+${workday}`, m => ({freq:RRule.MONTHLY, byweekday:weekdays, bysetpos:[position(m[1])]})],
    [`${prefix}\\s+(\\d+)\\s+${workday}`, m => ({freq:RRule.DAILY, byweekday:weekdays, businessInterval:+m[1]})],
    [`${prefix}\\s+(?:last day(?: of (?:the )?month)?|последний день(?: месяца)?)`, () => ({freq:RRule.MONTHLY, bymonthday:-1})],
    [`${prefix}\\s+(${ordinal})\\s+(${WD})`, m => ({freq:RRule.MONTHLY, byweekday:[new rrule.Weekday(weekday(m[2])-1, position(m[1]))]})],
    [`${prefix}\\s+(?:other|вторую|второй)\\s+(${WD})`, m => ({freq:RRule.WEEKLY, interval:2, byweekday:[weekday(m[1])-1], otherWeekday:true})],
    [`${prefix}\\s+(${WD}(?:${separator}${WD})*)`, m => ({freq:RRule.WEEKLY, byweekday:all(m[1], WD).map(p => weekday(p[0])-1)})],
    [`${prefix}\\s+(?:${workday}|будни)`, () => ({freq:RRule.WEEKLY, byweekday:weekdays})],
    [`${prefix}\\s+(?:weekends?|выходные)`, () => ({freq:RRule.WEEKLY, byweekday:[5]})],
    [`${prefix}\\s+(morning|noon|afternoon|evening|night|утро|полдень|вечер|ночь)`, m => ({freq:RRule.DAILY, clock:parseClock(m[1].toLowerCase())})],
    [`${prefix}\\s+(?:quarter|квартал)|quarterly|ежеквартально`, () => ({freq:RRule.MONTHLY, interval:3})],
    [`${prefix}\\s+(?:(\\d+|other|two|два|две|вторую|второй|второе)\\s+)?(${UNIT_PATTERN})`, m => ({freq:frequency[unitName(m[2].toLowerCase())], interval:m[1] && !/^\d+$/.test(m[1]) ? 2 : +(m[1] || 1)})],
    [`${prefix}\\s+(${monthlyDay}(?:${separator}${monthlyDay})*)`, m => ({freq:RRule.MONTHLY, bymonthday:all(m[1], '\\d+').map(p => +p[0])})],
    ['daily|everyday|ежедневно|ежедневный|weekly|еженедельно|еженедельный|monthly|ежемесячно|ежемесячный|yearly|ежегодно|ежегодный', m => ({freq:/^(daily|everyday|ежеднев)/i.test(m[0]) ? RRule.DAILY : /^(weekly|еженедель)/i.test(m[0]) ? RRule.WEEKLY : /^(monthly|ежемесяч)/i.test(m[0]) ? RRule.MONTHLY : RRule.YEARLY})],
    [`after\\s+(\\d+)\\s+(${UNIT_PATTERN})`, m => ({freq:frequency[unitName(m[2].toLowerCase())], interval:+m[1], completion:true})],
  ];
  let match, options;
  for (const [pattern, make] of patterns) { const m = rx(pattern).exec(text); if (m) {match=m; options=make(m); break;} }
  if (!match) return rx(prefix).test(text) ? {error:'Unsupported recurrence expression'} : null;
  const rules = options.rules || [options];
  if (rules.length > 32) return {error:'Too many recurrence dates'};
  const completion = /(?:after completion|после выполнения)/iu.exec(text);
  const mode = completion || match[0].includes('!') || options.completion ? 'after_completion' : 'calendar';
  const businessInterval = options.businessInterval;
  const clock = options.clock;
  const otherWeekday = options.otherWeekday;
  for (const rule of rules) {
    if (rule.interval !== undefined && (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 1000)) return {error:'Invalid recurrence interval'};
    if (rule.bymonthday && [].concat(rule.bymonthday).some(d => d !== -1 && (d < 1 || d > 31))) return {error:'Invalid day of month'};
    if (rule.bymonth && rule.bymonthday && (!ref.set({year:2024, month:rule.bymonth, day:rule.bymonthday}).isValid || ref.set({year:2024, month:rule.bymonth, day:rule.bymonthday}).month !== rule.bymonth)) return {error:'Invalid annual date'};
    if (rule.byweekday?.some(d => typeof d !== 'number' && (d.n !== -1 && (d.n < 1 || d.n > 5)))) return {error:'Ordinal weekday must be 1..5 or last'};
    if (rule.bysetpos?.some(n => n !== -1 && (n < 1 || n > 23))) return {error:'Invalid workday of month'};
    if (mode === 'after_completion' && (rule.byweekday || rule.bymonth || rule.bymonthday || rule.bysetpos || rules.length > 1)) return {error:'Completion-based calendar selections are not supported'};
    delete rule.clock; delete rule.otherWeekday; delete rule.businessInterval; delete rule.completion;
  }
  if (businessInterval !== undefined && (businessInterval < 1 || businessInterval > 1000)) return {error:'Invalid workday interval'};
  const spans = [span(match, 'recurrence')];
  if (completion) spans.push(span(completion, 'mode'));
  let start = null, until = null, duration = null;
  const marker = /(?<!\p{L})(?:starting(?: on| at)?|from|начиная(?: с| в)?|ending(?: on)?|until|заканчивая(?: через)?|до|с|for|в течение)(?!\p{L})\s+/giu;
  const markers = [...text.matchAll(marker)].filter(m => m.index >= match.index + match[0].length);
  for (let i=0; i<markers.length; i++) {
    const m=markers[i], offset=m.index+m[0].length, end=markers[i+1]?.index ?? text.length;
    const tail=text.slice(offset,end).trimEnd().replace(/,\s*$/, '');
    const isStart=/^(starting|from|начиная|с\s)/iu.test(m[0]);
    const isDuration=/^(for|в течение)/iu.test(m[0]);
    if (isDuration) {
      const d = new RegExp(`^(\\d+)\\s+(${UNIT_PATTERN})${right}`, 'iu').exec(tail);
      if (!d || +d[1] < 1 || +d[1] > 1000 || duration) return {error:'Invalid recurrence duration'};
      duration = {[unitName(d[2].toLowerCase())]:+d[1]};
      spans.push({start:m.index, end:offset+d[0].length, text:text.slice(m.index,offset+d[0].length), kind:'until'});
      continue;
    }
    const relativeEnd=/через/iu.test(m[0]);
    // A boundary may have a leading preposition that belongs to the boundary, not the task title.
    const leading = /^(?:в|on)\s+/iu.exec(tail)?.[0] || '';
    const phrase = (relativeEnd ? 'через ' : '') + tail.slice(leading.length);
    let parsed=extractDate(phrase,ref,settings);
    if (!parsed?.date || parsed.error || parsed.span.start !== 0 || (isStart ? start : until)) return {error:'Invalid recurrence boundary'};
    if (isStart && parseClock(phrase.slice(0, parsed.span.end))) parsed={...parsed, date:ref.startOf('day').set({hour:parsed.date.hour,minute:parsed.date.minute})};
    const consumed=leading.length+parsed.span.end-(relativeEnd?6:0);
    const begin=text.slice(match.index+match[0].length,m.index).trimEnd().endsWith(',') ? text.lastIndexOf(',',m.index) : m.index;
    spans.push({start:begin,end:offset+consumed,text:text.slice(begin,offset+consumed),kind:isStart?'start':'until'});
    if (isStart) start=parsed; else until=parsed.date.endOf('day');
  }
  if (duration) {
    if (until) return {error:'Conflicting recurrence end dates'};
    until=(start?.date || ref).startOf('day').plus(duration).minus({days:1}).endOf('day');
  }
  if (start && until && start.date > until) return {error:'Recurrence ends before it starts'};
  let rest=text;
  for(const s of spans) rest=rest.slice(0,s.start)+' '.repeat(s.end-s.start)+rest.slice(s.end);
  if(rx(prefix).test(rest) || /\b(?:except|until|starting|ending|for)\b|(?<!\p{L})(?:кроме|начиная|заканчивая|в течение)(?!\p{L})/iu.test(rest.slice(match.index + match[0].length))) return {error:'Unsupported recurrence modifier'};
  // A matched prefix must not hide an unsupported list or ordinal/month qualifier.
  const suffix=rest.slice(match.index+match[0].length).trimStart();
  if (/^,|^в\s+(?:перв|послед|втор|трет|четверт|пят)/iu.test(suffix) || new RegExp(`^(?:${MO}|${WD}|${UNIT_PATTERN}|рабочи|on\\s+the|of\\s+the)`, 'iu').test(suffix)) return {error:'Unsupported recurrence suffix'};
  return {options:rules[0], rules, spans, mode, start, until, otherWeekday, clock, businessInterval};
}
