import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesSubmitShortcut } from '../public/submit-shortcut.js';
test('task submit supports Enter or Ctrl/Command+Enter', () => {
  assert.equal(matchesSubmitShortcut({key:'Enter'},'enter'), true);
  assert.equal(matchesSubmitShortcut({key:'Enter',ctrlKey:true},'enter'), false);
  assert.equal(matchesSubmitShortcut({key:'Enter'},'ctrl-enter'), false);
  assert.equal(matchesSubmitShortcut({key:'Enter',ctrlKey:true},'ctrl-enter'), true);
  assert.equal(matchesSubmitShortcut({key:'Enter',metaKey:true},'ctrl-enter'), true);
});
test('autocomplete, composition, repeat and unrelated shortcuts cannot submit', () => {
  for (const flag of ['isComposing','repeat','altKey','shiftKey','defaultPrevented']) {
    assert.equal(matchesSubmitShortcut({key:'Enter',[flag]:true},'enter'),false);
    assert.equal(matchesSubmitShortcut({key:'Enter',ctrlKey:true,[flag]:true},'ctrl-enter'),false);
  }
  assert.equal(matchesSubmitShortcut({key:'Tab'}),false);
});
