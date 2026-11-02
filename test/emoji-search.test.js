import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexEmojis, searchEmojis } from '../public/emoji-search.js';
import { entityFields } from '../server/projects.js';
const dataset = JSON.parse(readFileSync(new URL('../public/emojis.json', import.meta.url)));
const entries = indexEmojis(dataset.emojis);
const find = (query, group = '') => searchEmojis(entries, query, group).map(e => e.emoji);
test('emoji search supports Russian, English, multiple words and case', () => {
  assert.ok(find('РАБОТА').includes('💼'));
  assert.ok(find('кот').includes('🐈'));
  assert.ok(find('travel').includes('✈️'));
  assert.ok(find('file folder').includes('📁'));
  assert.deepEqual(find('учёба'), find('учеба'));
  assert.ok(find('❤').includes('❤️'));
});
test('emoji search filters categories and handles empty results', () => {
  const result = searchEmojis(entries, '', '3');
  assert.ok(result.length > 0);
  assert.ok(result.every(e => e.group === 3));
  assert.deepEqual(find('impossible-query-xyz'), []);
  assert.equal(find('')[0], '📁');
  assert.equal(entries[0].emoji, dataset.emojis[0].emoji);
});
test('bundled emoji dataset has unique, server-compatible icons and valid categories', () => {
  assert.ok(entries.length > 1800);
  assert.equal(new Set(entries.map(e => e.emoji)).size, entries.length);
  for (const entry of entries) {
    assert.ok(dataset.groups.some(g => g.id === entry.group));
    assert.doesNotThrow(() => entityFields({ name: 'Test', iconType: 'emoji', color: '#112233', emoji: entry.emoji }));
  }
});
