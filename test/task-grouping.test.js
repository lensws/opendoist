import test from 'node:test';
import assert from 'node:assert/strict';
import {categoryGroups} from '../public/task-grouping.js';
test('categories separate projects and sections by identity, preserve chronology within groups and include inbox',()=>{
 const projects=[{id:'b',name:'Работа'},{id:'a',name:'Работа'}],sections=[{id:'s',projectId:'a',name:'Планы'}];
 const tasks=[{id:1,projectId:'a',sectionId:'s'},{id:2,projectId:'b'},{id:3,projectId:'a',sectionId:'s'},{id:4},{id:5,projectId:'a'}];
 const groups=categoryGroups(tasks,projects,sections);
 assert.deepEqual(groups.map(g=>g.tasks.map(t=>t.id)),[[4],[2],[5],[1,3]]);
 assert.deepEqual(groups.map(g=>g.title),['Входящие','Работа · Без раздела','Работа · Без раздела','Работа · Планы']);
 assert.equal(new Set(groups.map(g=>g.key)).size,4);
 assert.deepEqual(categoryGroups([],projects,sections),[]);
});
