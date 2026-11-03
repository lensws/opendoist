import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, occurrences, nextAfterCompletion } from '../src/index.js';
const now='2026-01-05T07:30:00+03:00'; // Monday, before morning defaults.
const settings={now,timezone:'Europe/Moscow'};
const cases=[
  [['каждое утро','every morning'], ['2026-01-05 09:00','2026-01-06 09:00','2026-01-07 09:00']],
  [['каждый полдень','every noon'], ['2026-01-05 12:00','2026-01-06 12:00','2026-01-07 12:00']],
  [['каждый вечер','every evening'], ['2026-01-05 19:00','2026-01-06 19:00','2026-01-07 19:00']],
  [['каждую ночь','every night'], ['2026-01-05 22:00','2026-01-06 22:00','2026-01-07 22:00']],
  [['каждые выходные','every weekend'], ['2026-01-10','2026-01-17','2026-01-24']],
  [['каждое 27-е','каждое 27','every 27th','every 27'], ['2026-01-27','2026-02-27','2026-03-27']],
  [['каждый последний день','every last day'], ['2026-01-31','2026-02-28','2026-03-31']],
  [['каждое 2, 15, 27','кажд 2, 15, 27','every 2, 15, 27','ev 2, 15, 27'], ['2026-01-15','2026-01-27','2026-02-02']],
  [['кажд 14 янв, 14 апр, 15 июн, 15 сент','every 14 jan, 14 apr, 15 jun, 15 sep'], ['2026-01-14','2026-04-14','2026-06-15','2026-09-15','2027-01-14']],
  [['каждую 1 среду янв, 3 чт июл','every 1st wed jan, 3rd thu jul','every 1st Wednesday of January, 3rd Thursday of July'], ['2026-01-07','2026-07-16','2027-01-06','2027-07-15']],
  [['каждый первый рабочий день','every first workday'], ['2026-02-02','2026-03-02','2026-04-01']],
  [['каждый последний рабочий день в 15:00','every last workday at 3pm'], ['2026-01-30 15:00','2026-02-27 15:00','2026-03-31 15:00']],
  [['каждый 15 рабочий день, первый рабочий день, последний рабочий день','every 15th workday, first workday, last workday'], ['2026-01-21','2026-01-30','2026-02-02','2026-02-20']],
  [['каждый 3 рабочий день','every 3 workday'], ['2026-01-08','2026-01-13','2026-01-16','2026-01-21']],
  [['каждый квартал','ежеквартально','every quarter','quarterly'], ['2026-04-05','2026-07-05','2026-10-05']],
  [['каждые два дня','every other day'], ['2026-01-07','2026-01-09','2026-01-11']],
  [['каждую вторую неделю','every other week'], ['2026-01-19','2026-02-02','2026-02-16']],
  [['каждый второй месяц','every other month'], ['2026-03-05','2026-05-05','2026-07-05']],
  [['каждый второй год','every other year'], ['2028-01-05','2030-01-05','2032-01-05']],
  [['каждую вторую пт','every other fri'], ['2026-01-16','2026-01-30','2026-02-13']],
  [['кажд сред вечером','every wed in the evening'], ['2026-01-07 19:00','2026-01-14 19:00','2026-01-21 19:00']],
  [['каждые 12 часов с 9:00','every 12 hours starting at 9am'], ['2026-01-05 09:00','2026-01-05 21:00','2026-01-06 09:00']],
  [['каждые 12 часов начиная с 21:00','every 12 hours starting at 9pm'], ['2026-01-05 21:00','2026-01-06 09:00','2026-01-06 21:00']],
  [['каждый день с 10 мая до 20 мая','everyday from 10 May until 20 May'], ['2026-05-10','2026-05-11','2026-05-12']],
  [['каждую среду, пятницу, субботу заканчивая в субботу','every Wednesday, Friday, Saturday ending Saturday'], ['2026-01-07','2026-01-09','2026-01-10']],
  [['каждый день начиная с 3 августа','каждый день с 3 августа','everyday starting on aug 3','everyday from aug 3'], ['2026-08-03','2026-08-04','2026-08-05']],
  [['каждый пн, пт в 20:00','every mon, fri at 20:00'], ['2026-01-05 20:00','2026-01-09 20:00','2026-01-12 20:00']],
  [['каждую 3 пятницу в 8','every 3rd Friday at 8'], ['2026-01-16 08:00','2026-02-20 08:00','2026-03-20 08:00']],
];
const label=d=>d.date+(d.time?' '+d.time:'');
for(const [phrases,expected] of cases) for(const phrase of phrases) test(`recurrence corpus: ${phrase}`,()=>{
  const t=parseTask(`📝 Task ${phrase}`,settings);
  assert.equal(t.status,'scheduled',JSON.stringify(t)); assert.equal(t.title,'📝 Task'); assert.ok(t.recurrence);
  for(const s of t.spans) assert.equal(t.source.slice(s.start,s.end),s.text);
  assert.deepEqual(occurrences(t,{after:now,count:expected.length}).map(label),expected);
  const next=nextAfterCompletion(t,t.due.instant || `${t.due.date}T12:00:00+03:00`);
  assert.ok(next); assert.notEqual(label(next),label(t.due));
});
for(const phrase of ['каждый день в течение 3 недель','everyday for 3 weeks']) test(`duration is bounded: ${phrase}`,()=>{
  const t=parseTask(`Task ${phrase}`,settings);
  assert.equal(t.title,'Task'); assert.equal(t.due.date,'2026-01-05');
  const dates=occurrences(t,{after:now,count:30}).map(d=>d.date);
  assert.equal(dates.length,20); assert.equal(dates.at(-1),'2026-01-25');
  assert.equal(nextAfterCompletion(t,'2026-01-25T12:00:00+03:00'),null);
});
for(const phrase of ['каждый день до 3 августа','everyday ending aug 3','everyday until aug 3']) test(`inclusive end: ${phrase}`,()=>{
  const t=parseTask(`Task ${phrase}`,settings); assert.equal(t.title,'Task');
  assert.deepEqual(occurrences(t,{after:'2026-08-02T12:00:00+03:00',count:3}).map(d=>d.date),['2026-08-03']);
});
for(const phrase of ['каждые! 5 дней','every! 5 days','after 5 days']) test(`completion anchored: ${phrase}`,()=>{
  const t=parseTask(`Task ${phrase}`,settings); assert.equal(t.title,'Task'); assert.equal(t.due.date,'2026-01-05');
  assert.equal(t.recurrence.mode,'after_completion'); assert.equal(nextAfterCompletion(t,'2026-01-09T12:00:00+03:00').date,'2026-01-14');
});
for(const [phrases,date] of [ [['день святого валентина','день валентина','valentine',"Valentine's Day"],'2026-02-14'],[['хэллоуин','halloween'],'2026-10-31'],[['канун нового года','new year eve'],'2026-12-31'],[['новый год','new year day'],'2027-01-01'] ]) for(const phrase of phrases) test(`holiday: ${phrase}`,()=>{
 const t=parseTask(`Task ${phrase}`,settings);assert.equal(t.title,'Task');assert.equal(t.due.date,date);assert.equal(t.recurrence,null);
});
for(const phrase of ['каждый пн в 8, вт в 9','every mon at 8pm, tue at 9pm','every Monday every 1 hour','каждый день кроме','every day except','every 2 months on the first Friday of the month','каждые 2 месяца в первую пятницу месяца','каждое 32','every 31 feb','every 0 workday','каждую 6 пятницу','кажд сред блабла в 99','каждый день в течение трех неизвестных']) test(`no partial schedule: ${phrase}`,()=>{
 const t=parseTask(`Task ${phrase}`,settings); assert.equal(t.status,'needs_review',JSON.stringify(t)); assert.equal(t.due,null);assert.equal(t.recurrence,null);
});

test('annual unions preserve pairs and deduplicate overlapping dates across years',()=>{
  const t=parseTask('Task every Jan 14, Apr 14, Jun 15, Sep 15',settings);
  assert.equal(t.title,'Task'); assert.equal(t.recurrence.rrules.length,4);
  assert.deepEqual(occurrences(t,{after:'2026-01-01T00:00:00Z',count:8}).map(d=>d.date),['2026-01-14','2026-04-14','2026-06-15','2026-09-15','2027-01-14','2027-04-14','2027-06-15','2027-09-15']);
  const duplicate=parseTask('Task every Jan 14, Jan 14',settings);
  assert.deepEqual(occurrences(duplicate,{after:now,count:2}).map(d=>d.date),['2026-01-14','2027-01-14']);
});
test('workday intervals cross weekends, skip missed dates and respect an end',()=>{
  const t=parseTask('Task every 3 workday until Feb 1',settings);
  assert.equal(t.due.date,'2026-01-05');
  assert.equal(nextAfterCompletion(t,'2026-01-10T12:00:00+03:00').date,'2026-01-13');
  assert.equal(nextAfterCompletion(t,'2026-01-30T12:00:00+03:00'),null);
  const weekend=parseTask('Task every 2 workday',{...settings,now:'2026-01-10T12:00:00+03:00'});
  assert.equal(weekend.due.date,'2026-01-12');
  assert.equal(nextAfterCompletion(weekend,'2026-01-12T12:00:00+03:00').date,'2026-01-14');
  const long=parseTask('Task every 1000 workday',settings);
  const far=nextAfterCompletion(long,'2040-01-01T12:00:00+03:00');
  assert.ok(far.date>'2040-01-01');
});
test('duration is relative to explicit start and all end rules in a union expire',()=>{
  const t=parseTask('Task every day starting Feb 1 for 3 weeks',settings);
  assert.equal(t.title,'Task');assert.equal(t.due.date,'2026-02-01');
  const dates=occurrences(t,{after:now,count:30}); assert.equal(dates.length,21);assert.equal(dates.at(-1).date,'2026-02-21');
  const union=parseTask('Task every 14 jan, 15 jun until 31 dec',settings);
  assert.deepEqual(occurrences(union,{after:now,count:5}).map(d=>d.date),['2026-01-14','2026-06-15']);
});
test('new recurrence forms handle leap days and DST without silently shifting the clock',()=>{
  const leap=parseTask('Task every 29 feb, 31 dec',settings);
  assert.deepEqual(occurrences(leap,{after:now,count:3}).map(d=>d.date),['2026-12-31','2027-12-31','2028-02-29']);
  const dst=parseTask('Task every last Sunday at 2:30',{now:'2026-02-01T12:00:00+01:00',timezone:'Europe/Berlin'});
  assert.deepEqual(occurrences(dst,{after:'2026-02-01T00:00:00Z',count:2}).map(d=>d.date),['2026-02-22','2026-04-26']);
});
test('Russian in-N-days stays a one-off date; English after-N-days is explicit recurrence',()=>{
  const t=parseTask('Task через 10 дней',settings);assert.equal(t.due.date,'2026-01-15');assert.equal(t.recurrence,null);
  const r=parseTask('Task after 10 days starting Aug 10',settings);assert.equal(r.due.date,'2026-08-10');assert.equal(r.recurrence.mode,'after_completion');
});

test('punctuation, Russian ordinal suffixes and ordinary title words retain exact spans',()=>{
  for(const phrase of ['каждую 3-ю пятницу','every mon, tues, wed, and fri','every 14 days at 7am, starting 1 Nov']) {
    const t=parseTask(`Task ${phrase}`,settings);assert.equal(t.status,'scheduled');assert.equal(t.title,'Task');
    for(const s of t.spans) assert.equal(t.source.slice(s.start,s.end),s.text);
  }
  assert.equal(parseTask('Prepare for meeting every morning',settings).title,'Prepare for meeting');
});

test('a passed time does not reset the workday interval to tomorrow',()=>{
  const t=parseTask('Task every 3 workday at 8am',{...settings,now:'2026-01-05T10:30:00+03:00'});
  assert.equal(t.due.date,'2026-01-08');assert.equal(t.due.time,'08:00');
  assert.deepEqual(occurrences(t,{after:'2026-01-08T09:00:00+03:00',count:2}).map(d=>d.date),['2026-01-13','2026-01-16']);
});

for (const suffix of ['', ' в 09:00']) test(`Russian weekday synonyms${suffix}`, () => {
  const options = {...settings, now:'2026-01-09T07:30:00+03:00'}; // Friday.
  const working = parseTask(`Зарядка каждый рабочий день${suffix}`, options);
  const weekday = parseTask(`Зарядка каждый будний день${suffix}`, options);
  for (const task of [working, weekday]) {
    assert.equal(task.status, 'scheduled');
    assert.equal(task.title, 'Зарядка');
    assert.equal(task.due.date, '2026-01-09');
    assert.equal(task.due.time, suffix ? '09:00' : null);
    assert.deepEqual(occurrences(task, {after:'2026-01-09T23:00:00+03:00', count:3}).map(d=>d.date), ['2026-01-12','2026-01-13','2026-01-14']);
    assert.equal(nextAfterCompletion(task, '2026-01-09T12:00:00+03:00').date, '2026-01-12');
  }
  assert.equal(weekday.recurrence.rrule, working.recurrence.rrule);
});
