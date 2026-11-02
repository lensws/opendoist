import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarRange, nextAnchor, calendarTaskDate, calendarClock } from '../public/calendar-model.js';
import { rescheduleTask } from '../server/calendar.js';
import { parseTask, nextAfterCompletion } from '../src/index.js';
test('calendar grids handle leap years, Monday starts and month boundaries', () => {
  assert.equal(calendarRange('2024-02-29','month')[0], '2024-01-29');
  assert.equal(calendarRange('2024-02-29','month').at(-1), '2024-03-03');
  assert.equal(calendarRange('2026-11-01','week')[0], '2026-10-26');
  assert.deepEqual(calendarRange('2026-12-31','three-days'), ['2026-12-31','2027-01-01','2027-01-02']);
  assert.equal(nextAnchor('2026-01-31','month',1), '2026-02-01');
  assert.equal(nextAnchor('2026-01-01','month',-1), '2025-12-01');
});
test('calendar timezone conversion preserves all-day dates', () => {
  assert.deepEqual(calendarTaskDate({due:{allDay:false, instant:'2026-11-02T23:30:00Z'}},'Europe/Moscow'), {date:'2026-11-03',time:'02:30'});
  assert.deepEqual(calendarTaskDate({due:{allDay:true,date:'2026-11-02'}},'America/New_York'), {date:'2026-11-02',time:null});
});
test('rescheduling preserves recurrence, reminders, deadline and task timezone', () => {
  const task = {...parseTask('Полив каждый день в 10', {now:'2026-11-02T06:00:00Z',timezone:'Europe/Moscow'}), reminders:[{kind:'before',minutes:30}], deadline:{date:'2026-12-01'}};
  const next = rescheduleTask(task, {date:'2026-11-05',time:'12:00',timezone:'Europe/Berlin'});
  assert.equal(next.due.time,'14:00'); assert.equal(next.due.timezone,'Europe/Moscow');
  assert.deepEqual(next.recurrence,task.recurrence); assert.deepEqual(next.reminders,task.reminders); assert.deepEqual(next.deadline,task.deadline);
  assert.equal(nextAfterCompletion(next, '2026-11-05T12:00:00Z').date,'2026-11-06');
  assert.throws(() => rescheduleTask(task,{date:null}), /отключите повторение/);
});
test('rescheduling validates dates, DST gaps, completion and removing dates', () => {
  assert.throws(() => rescheduleTask({}, {date:'2026-02-30'}), /времени нет/);
  assert.throws(() => rescheduleTask({}, {date:'2026-03-29',time:'02:30',timezone:'Europe/Berlin'}), /времени нет/);
  assert.throws(() => rescheduleTask({}, {date:'2026-11-02',time:'25:00'}), /корректную/);
  assert.throws(() => rescheduleTask({completedAt:'2026-11-01'}, {date:'2026-11-02'}), /Выполненную/);
  assert.equal(rescheduleTask({}, {date:'2026-11-02',time:null}).due.instant,null);
  assert.equal(rescheduleTask({due:{}}, {date:null}).status,'unscheduled');
});

test('current-time line uses calendar timezone and fractional hour across midnight', () => {
  const clock = calendarClock('Europe/Moscow', new Date('2026-11-02T21:30:30Z'));
  assert.equal(clock.date,'2026-11-03'); assert.equal(clock.time,'00:30'); assert.equal(clock.hour,0); assert.equal(clock.fraction,30.5/60);
  assert.equal(calendarClock('America/New_York', new Date('2026-11-02T21:30:30Z')).time,'16:30');
});

test('single-day calendar stays on the anchor and advances by one day', () => {
  assert.deepEqual(calendarRange('2026-12-31', 'day'), ['2026-12-31']);
  assert.equal(nextAnchor('2026-12-31', 'day', 1), '2027-01-01');
  assert.equal(nextAnchor('2024-03-01', 'day', -1), '2024-02-29');
});
