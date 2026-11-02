import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWorkspace } from '../public/workspace-data.js';

test('workspace reads start together and wait for every response', async () => {
  const pending = new Map();
  const result = fetchWorkspace(path => new Promise(resolve => pending.set(path, resolve)));
  assert.deepEqual([...pending.keys()], ['/settings', '/tasks', '/projects']);
  let settled = false;
  result.then(() => { settled = true; });
  pending.get('/projects')({ projects: [{id:'p'}], sections: [] });
  pending.get('/tasks')({ tasks: [{id:'t'}] });
  await Promise.resolve();
  assert.equal(settled, false);
  pending.get('/settings')({ settings: {timezone:'UTC'} });
  assert.deepEqual(await result, {
    settings: {timezone:'UTC'}, tasks: [{id:'t'}], projects: [{id:'p'}], sections: [],
  });
});

test('history is loaded only when requested and errors reject the whole snapshot', async () => {
  const calls = [];
  const data = await fetchWorkspace(async path => {
    calls.push(path);
    return {'/settings': {settings:{}}, '/tasks': {tasks:[]}, '/projects': {projects:[], sections:[]}, '/history': {history:[{id:'h'}]}}[path];
  }, true);
  assert.equal(calls.length, 4);
  assert.deepEqual(data.history, [{id:'h'}]);
  await assert.rejects(fetchWorkspace(async path => {
    if (path === '/projects') throw new Error('offline');
    return {};
  }), /offline/);
});
