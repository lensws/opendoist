// UTC arithmetic here represents calendar dates, not task instants or browser-local time.
export function shiftDate(date, days) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
export function calendarRange(anchor, mode) {
  if (mode === 'three-days') return Array.from({length:3}, (_, i) => shiftDate(anchor, i));
  const first = mode === 'month' ? `${anchor.slice(0,7)}-01` : anchor;
  const weekday = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const start = shiftDate(first, -weekday);
  if (mode === 'week') return Array.from({length:7}, (_, i) => shiftDate(start, i));
  const next = new Date(`${first}T12:00:00Z`); next.setUTCMonth(next.getUTCMonth()+1);
  const days = Math.ceil((weekday + Number(shiftDate(next.toISOString().slice(0,10), -1).slice(-2))) / 7) * 7;
  return Array.from({length:days}, (_, i) => shiftDate(start, i));
}
export function nextAnchor(anchor, mode, direction) {
  if (mode !== 'month') return shiftDate(anchor, direction * (mode === 'week' ? 7 : 3));
  const d = new Date(`${anchor.slice(0,7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth()+direction); return d.toISOString().slice(0,10);
}
export function calendarTaskDate(task, timezone) {
  if (!task.due) return null;
  if (task.due.allDay) return { date: task.due.date, time: null };
  // Format in the calendar's timezone so tasks from different zones share one time axis.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date(task.due.instant));
  const value = name => parts.find(p => p.type === name).value;
  return { date: `${value('year')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}` };
}
