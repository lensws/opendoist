import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, occurrences, nextAfterCompletion } from '../src/index.js';
const settings = { now: '2026-11-02T10:00:00+03:00', timezone: 'Europe/Moscow' };
const parse = text => parseTask(text, settings);
for (const [text, title] of [['Купить молоко завтра в 18:00', 'Купить молоко'], ['Buy milk tomorrow at 6pm', 'Buy milk']]) {
  test(text, () => {
    const task = parse(text);
    assert.equal(task.status, 'scheduled');
    assert.equal(task.title, title);
    assert.equal(task.due.date, '2026-11-03');
    assert.equal(task.due.time, '18:00');
    assert.equal(task.due.instant, '2026-11-03T15:00:00.000Z');
  });
}
for (const text of ['Отчёт каждую пятницу в 17:00', 'Report every friday at 5pm']) {
  test(text, () => {
    const task = parse(text);
    assert.equal(task.due.date, '2026-11-06');
    assert.equal(task.due.time, '17:00');
    assert.deepEqual(occurrences(task, { after: settings.now, count: 3 }).map(x => x.date), ['2026-11-06', '2026-11-13', '2026-11-20']);
  });
}
test('date without time remains all day', () => {
  assert.deepEqual(parse('Read tomorrow').due, { date: '2026-11-03', time: null, timezone: 'Europe/Moscow', instant: null, allDay: true });
});
test('plain title remains unchanged', () => {
  assert.equal(parse('Написать документацию').status, 'unscheduled');
  assert.equal(parse('Написать документацию').title, 'Написать документацию');
});
test('intervals advance from original calendar anchor', () => {
  const task = parse('Витамины каждые 3 дня');
  assert.equal(nextAfterCompletion(task, '2026-11-06T12:00:00+03:00').date, '2026-11-08');
});
for (const text of ['Витамины каждые 3 дня после выполнения', 'Vitamins every 3 days after completion']) {
  test(text, () => {
    const task = parse(text);
    assert.equal(task.recurrence.mode, 'after_completion');
    assert.equal(nextAfterCompletion(task, '2026-11-06T12:00:00+03:00').date, '2026-11-09');
    assert.throws(() => occurrences(task), /Calendar/);
  });
}
test('weekdays skip weekends', () => {
  const task = parse('Standup every weekdays at 9am');
  assert.deepEqual(occurrences(task, { after: '2026-11-06T10:00:00+03:00', count: 2 }).map(x => x.date), ['2026-11-09', '2026-11-10']);
});
test('monthly day 31 skips months without that day', () => {
  const task = parseTask('Pay every month', { ...settings, now: '2026-01-31T10:00:00+03:00' });
  assert.deepEqual(occurrences(task, { after: '2026-01-31T23:00:00+03:00', count: 2 }).map(x => x.date), ['2026-03-31', '2026-05-31']);
});
test('daily wall time survives DST change', () => {
  const task = parseTask('Coffee every day at 9am', { now: '2026-03-07T08:00:00-05:00', timezone: 'America/New_York' });
  const dates = occurrences(task, { after: '2026-03-07T10:00:00-05:00', count: 2 });
  assert.equal(dates[0].time, '09:00');
  assert.equal(dates[0].instant, '2026-03-08T13:00:00.000Z');
});
for (const text of ['Run every 0 days', 'Бегать каждый день до пятницы']) {
  test(`review: ${text}`, () => {
    const task = parse(text);
    assert.equal(task.status, 'needs_review');
    assert.equal(task.title, text);
    assert.equal(task.recurrence, null);
  });
}
test('invalid inputs are rejected', () => {
  assert.throws(() => parse(''), TypeError);
  assert.throws(() => parseTask('test', { timezone: 'Invalid/Zone' }), RangeError);
  assert.throws(() => parseTask('test', { now: 'oops' }), RangeError);
});
test('JSON round trip preserves schedule behavior', () => {
  const task = JSON.parse(JSON.stringify(parse('Run every day at 8am')));
  assert.equal(task.due.date, '2026-11-03');
  assert.equal(nextAfterCompletion(task, '2026-11-03T10:00:00+03:00').date, '2026-11-04');
});
test('singular weekday expression', () => {
  const task = parse('Standup every weekday at 9am');
  assert.equal(task.status, 'scheduled');
  assert.match(task.recurrence.rrule, /BYDAY=MO,TU,WE,TH,FR/);
});
test('invalid recurrence time is not silently dropped', () => {
  assert.equal(parse('Run every day at 25:00').status, 'needs_review');
});
test('DST nonexistent future occurrence is skipped', () => {
  const task = parseTask('Run every day at 2:30am', { now: '2026-03-07T01:00:00-05:00', timezone: 'America/New_York' });
  assert.equal(occurrences(task, { after: '2026-03-07T04:00:00-05:00', count: 1 })[0].date, '2026-03-09');
});
test('relative dates follow supplied timezone near midnight', () => {
  const task = parseTask('Read tomorrow', { now: '2026-11-02T23:30:00Z', timezone: 'Asia/Tokyo' });
  assert.equal(task.due.date, '2026-11-04');
});
