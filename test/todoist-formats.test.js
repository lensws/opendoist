import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, occurrences, nextAfterCompletion } from '../src/index.js';
// Behavioral corpus for the RU and EN date/time help pages (2026-11-02).
// Dates are fixed so these tests do not change as real time passes.
const now = '2026-01-05T10:30:00+03:00';
const defaults = { now, timezone: 'Europe/Moscow' };
const cases = [
  ['сегодня', '2026-01-05'], ['today', '2026-01-05'], ['tod', '2026-01-05'],
  ['завтра', '2026-01-06'], ['tomorrow', '2026-01-06'], ['tom', '2026-01-06'],
  ['следующая неделя', '2026-01-12'], ['next week', '2026-01-12'],
  ['следующий месяц', '2026-02-05'], ['next month', '2026-02-05'],
  ['27 янв', '2026-01-27'], ['jan 27', '2026-01-27'], ['27 jan', '2026-01-27'],
  ['01/27/2023', '2023-01-27'], ['27/01/2023', '2023-01-27'], ['2023/01/27', '2023-01-27'], ['2023-01-27', '2023-01-27'],
  ['27', '2026-01-27'], ['27th', '2026-01-27'],
  ['середина января', '2026-01-15'], ['mid January', '2026-01-15'],
  ['конец месяца', '2026-01-31'], ['end of month', '2026-01-31'],
  ['сегодня в 10', '2026-01-05', '10:00'], ['today at 10', '2026-01-05', '10:00'],
  ['завтра в 4', '2026-01-06', '16:00'], ['tomorrow at 16:00', '2026-01-06', '16:00'],
  ['Пт в 7', '2026-01-09', '19:00'], ['Пятница @ 7', '2026-01-09', '19:00'],
  ['Пт в 1900', '2026-01-09', '19:00'], ['Пт в 19:00', '2026-01-09', '19:00'],
  ['Fri 7pm', '2026-01-09', '19:00'], ['Fri at 7pm', '2026-01-09', '19:00'],
  ['Fri at 1900', '2026-01-09', '19:00'], ['Fri at 19:00', '2026-01-09', '19:00'],
  ['6', '2026-01-05', '18:00'], ['6pm', '2026-01-05', '18:00'],
  ['через 5 дней', '2026-01-10'], ['in 5 days', '2026-01-10'], ['+5 days', '2026-01-10'], ['+5 дней', '2026-01-10'],
  ['через 3 недели', '2026-01-26'], ['in 3 weeks', '2026-01-26'],
  ['через 2 часа', '2026-01-05', '12:30'], ['in 2 hours', '2026-01-05', '12:30'],
  ['утром', '2026-01-06', '09:00'], ['in the morning', '2026-01-06', '09:00'],
  ['днем', '2026-01-05', '12:00'], ['in the afternoon', '2026-01-05', '12:00'],
  ['вечером', '2026-01-05', '19:00'], ['in the evening', '2026-01-05', '19:00'],
  ['когда-нибудь', '2026-03-05'], ['someday', '2026-03-05'],
  ['на этой неделе', '2026-01-09'], ['later this week', '2026-01-09'],
  ['Пятница', '2026-01-09'], ['Friday', '2026-01-09'],
  ['следующая пятница', '2026-01-16'], ['next Friday', '2026-01-16'],
  ['следующие выходные', '2026-01-17'], ['next weekend', '2026-01-17'],
  ['на выходных', '2026-01-10'], ['this weekend', '2026-01-10'],
  ['в следующем году', '2027-01-01'], ['next year', '2027-01-01'],
  ['27/1', '2026-01-27'], ['3 пятница янв', '2026-01-16'], ['3rd friday jan', '2026-01-16'],
  ['завтра утром', '2026-01-06', '09:00'], ['tom morning', '2026-01-06', '09:00'], ['tommorning', '2026-01-06', '09:00'],
  ['завтра днем', '2026-01-06', '12:00'], ['tom afternoon', '2026-01-06', '12:00'], ['tomafternoon', '2026-01-06', '12:00'],
  ['завтра вечером', '2026-01-06', '19:00'], ['tom evening', '2026-01-06', '19:00'], ['tomevening', '2026-01-06', '19:00'],
  ['завтра ночью', '2026-01-06', '22:00'], ['tom night', '2026-01-06', '22:00'], ['tomnight', '2026-01-06', '22:00'],
  ['за 50 дней до нового года', '2026-11-11'], ["50 days before new year's eve", '2026-11-11'],
  ['6 недель до 21 июля', '2026-06-09'], ['6 weeks before 21 Jul', '2026-06-09'],
  ['28 дней после 21 июля', '2026-08-18'], ['28 days after 21 July', '2026-08-18'],
];
for (const [phrase, date, time = null] of cases) {
  test(`documented format: ${phrase}`, () => {
    const task = parseTask(phrase, defaults);
    assert.equal(task.status, 'scheduled', JSON.stringify(task));
    assert.equal(task.due.date, date);
    assert.equal(task.due.time, time);
    assert.equal(task.title, '');
    // Bare numeric dates belong to the date field; do not steal item quantities.
    if (!/^\d+$/.test(phrase)) {
      const embedded = parseTask(`📝 Task ${phrase}`, defaults);
      assert.equal(embedded.title, '📝 Task');
      assert.deepEqual(embedded.due, task.due);
      for (const s of embedded.spans) assert.equal(embedded.source.slice(s.start, s.end), s.text);
    }
  });
}
for (const phrase of ['без срока', 'нет срока', 'no date', 'no due date']) {
  test(`clear date: ${phrase}`, () => {
    const task = parseTask(`Task ${phrase}`, defaults);
    assert.equal(task.dateAction, 'clear'); assert.equal(task.due, null); assert.equal(task.title, 'Task');
  });
}
test('next weekday follows calendar week, not always two occurrences', () => {
  assert.equal(parseTask('next Tuesday', { ...defaults, now: '2025-10-20T12:00:00+03:00' }).due.date, '2025-10-28');
  assert.equal(parseTask('следующий вторник', { ...defaults, now: '2025-10-22T12:00:00+03:00' }).due.date, '2025-10-28');
});
test('late evening time-only rolls to tomorrow', () => {
  assert.equal(parseTask('6pm', { ...defaults, now: '2026-01-05T20:00:00+03:00' }).due.date, '2026-01-06');
});
test('configurable next-week and weekend days', () => {
  assert.equal(parseTask('next week', { ...defaults, nextWeekDay: 3 }).due.date, '2026-01-07');
  assert.equal(parseTask('this weekend', { ...defaults, weekendDay: 7 }).due.date, '2026-01-11');
});
for (const phrase of ['каждый 3 вторник начиная с 20 августа заканчивая через 6 месяцев', 'every 3rd Tuesday starting Aug 20 ending in 6 months']) {
  test(`bounded ordinal recurrence: ${phrase}`, () => {
    const task = parseTask(`Task ${phrase}`, { ...defaults, now: '2026-07-01T10:00:00+03:00' });
    assert.equal(task.status, 'scheduled', JSON.stringify(task));
    assert.equal(task.title, 'Task');
    assert.equal(task.due.date, '2026-09-15');
    assert.deepEqual(occurrences(task, { after: '2026-07-01T00:00:00+03:00', count: 10 }).map(d => d.date), ['2026-09-15', '2026-10-20', '2026-11-17', '2026-12-15']);
  });
}
test('deadline stays independent of a recurrence', () => {
  const task = parseTask('Task каждые 2 дня в 12:00 {28 фев.}', defaults);
  assert.equal(task.title, 'Task'); assert.equal(task.deadline.date, '2026-02-28');
  assert.equal(task.due.time, '12:00');
  assert.equal(nextAfterCompletion(task, '2026-01-05T13:00:00+03:00').date, '2026-01-07');
});
test('monthly adjective in task name', () => {
  const task = parseTask('Написать ежемесячный отчет', defaults);
  assert.equal(task.title, 'Написать отчет'); assert.equal(task.recurrence.frequency, 'MONTHLY');
});
test('other Wednesday starts at second upcoming Wednesday', () => {
  assert.equal(parseTask('Task every other Wednesday', defaults).due.date, '2026-01-14');
});
test('quantities stay in title', () => {
  assert.equal(parseTask('Купить 6 яиц', defaults).status, 'unscheduled');
});
for (const phrase of ['every July 19', 'каждый 19 июля']) {
  test(`annual birthday: ${phrase}`, () => {
    const task = parseTask(`Birthday ${phrase}`, defaults);
    assert.equal(task.title, 'Birthday'); assert.equal(task.due.date, '2026-07-19');
    assert.deepEqual(occurrences(task, { after: now, count: 2 }).map(d => d.date), ['2026-07-19', '2027-07-19']);
  });
}
test('calendar interval keeps today as anchor when time has passed', () => {
  const task = parseTask('Exercise every 3 days at 8am', defaults);
  assert.equal(task.due.date, '2026-01-08');
});
for (const phrase of ['Tomorrow at 25:00', 'Завтра в 99', '31/02/2026', '2026-02-29']) {
  test(`invalid date/time: ${phrase}`, () => assert.equal(parseTask(phrase, defaults).status, 'needs_review'));
}
test('valid leap day and month-end arithmetic', () => {
  assert.equal(parseTask('2028-02-29', defaults).due.date, '2028-02-29');
  assert.equal(parseTask('next month', { ...defaults, now: '2026-01-31T10:00:00+03:00' }).due.date, '2026-02-28');
});
test('clear date cannot coexist with recurrence', () => {
  assert.equal(parseTask('every day no date', defaults).status, 'needs_review');
});
test('multiple explicit dates need review', () => {
  assert.equal(parseTask('сегодня завтра', defaults).status, 'needs_review');
});
test('English deadline example', () => {
  const task = parseTask('Task every 2 days at 12:00 {Feb 28}', defaults);
  assert.equal(task.title, 'Task'); assert.equal(task.deadline.date, '2026-02-28');
});
test('completion-based month and bounded recurrence', () => {
  const task = parseTask('Task every! 2 months until 31 dec', defaults);
  assert.equal(nextAfterCompletion(task, '2026-02-20T10:00:00+03:00').date, '2026-04-20');
  assert.equal(nextAfterCompletion(task, '2026-12-20T10:00:00+03:00'), null);
});
test('weekday list and every-other-week regression', () => {
  const task = parseTask('Task every monday and friday', defaults);
  assert.deepEqual(occurrences(task, { after: now, count: 3 }).map(d => d.date), ['2026-01-09', '2026-01-12', '2026-01-16']);
  assert.equal(nextAfterCompletion(parseTask('Task every other week', defaults), now).date, '2026-01-19');
});
test('early completion advances past the occurrence being completed', () => {
  const task = parseTask('Report every Friday', defaults);
  assert.equal(nextAfterCompletion(task, now).date, '2026-01-16');
});
test('numeric dates preserve locale and explicit date-order setting', () => {
  assert.equal(parseTask('01/02/2026', { ...defaults, language: 'ru' }).due.date, '2026-02-01');
  assert.equal(parseTask('01/02/2026', { ...defaults, language: 'en' }).due.date, '2026-01-02');
  assert.equal(parseTask('01/02/2026', { ...defaults, language: 'en', dateOrder: 'DMY' }).due.date, '2026-02-01');
});
test('literal generic weekday has explicit interpretation warning', () => {
  for (const phrase of ['следующий будний день', 'next weekday']) {
    const task = parseTask(phrase, defaults);
    assert.equal(task.due.date, '2026-01-06');
    assert.match(task.warnings[0], /placeholder/);
  }
});
test('later-this-week behavior on Friday and Sunday is explicit', () => {
  assert.equal(parseTask('later this week', { ...defaults, now: '2026-01-09T10:00:00+03:00' }).due.date, '2026-01-11');
  assert.equal(parseTask('later this week', { ...defaults, now: '2026-01-11T10:00:00+03:00' }).due.date, '2026-01-18');
});
