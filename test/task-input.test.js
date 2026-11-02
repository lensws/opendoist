import test from 'node:test';
import assert from 'node:assert/strict';
import { projectQuery, dateSegments } from '../public/task-input.js';
test('project completion respects caret and hashtag boundaries', () => {
  assert.deepEqual(projectQuery('Отчёт #Раб', 10), { start: 6, end: 10, query: 'раб' });
  assert.deepEqual(projectQuery('#', 1), { start: 0, end: 1, query: '' });
  assert.equal(projectQuery('C# код', 6), null);
  assert.equal(projectQuery('https://site/#work', 18), null);
  assert.equal(projectQuery('#Мои проекты', 12).query, 'мои проекты');
  assert.equal(projectQuery('Задача #Work завтра', 12).query, 'work');
});
test('date highlights use exact parser spans, trim offsets and reject stale results', () => {
  const source = 'Отчёт завтра', spans = [{start:6,end:12}];
  assert.deepEqual(dateSegments('  Отчёт завтра ', source, spans), [{text:'  Отчёт ',marked:false},{text:'завтра',marked:true},{text:' ',marked:false}]);
  assert.deepEqual(dateSegments('Отчёт сегодня', source, spans), [{text:'Отчёт сегодня',marked:false}]);
  assert.equal(dateSegments('Код <script> завтра', 'Код <script> завтра', [{start:13,end:19}]).map(s=>s.text).join(''), 'Код <script> завтра');
});
