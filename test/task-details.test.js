import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { orderedTree } from '../public/task-tree.js';
import { markdown } from '../public/markdown.js';
import { validateImport } from '../server/import.js';
const project = store => store.saveEntity('project',{name:'Work',iconType:'color',color:'#123456'});
const create = (store, title, patch={}) => store.create({title, due:null, ...patch});
const move = (store, task, patch={}) => store.moveTask(task.id,{previous:store.list().filter(t=>(t.projectId ?? null)===(task.projectId ?? null)).map(({id,revision})=>({id,revision})),...patch});
test('manual ordering, nesting, cycle rejection and stale concurrent moves',()=>{
 const s=new Store(':memory:'); try {
 const p=project(s), a=create(s,'A',{projectId:p.id}), b=create(s,'B',{projectId:p.id}), c=create(s,'C',{projectId:p.id});
 move(s,b,{beforeId:a.id}); assert.deepEqual(orderedTree(s.list()).map(e=>e.task.title),['C','B','A']);
 move(s,c,{parentId:a.id}); move(s,b,{parentId:c.id});
 assert.deepEqual(orderedTree(s.list()).map(e=>[e.task.title,e.depth]),[['A',0],['C',1],['B',2]]);
 assert.throws(()=>move(s,a,{parentId:b.id}),e=>e.status===400);
 const previous=s.list(); move(s,b,{parentId:null});
 assert.throws(()=>s.moveTask(a.id,{previous,parentId:null}),e=>e.status===409);
 assert.equal(s.get(b.id).parentId,null);
 } finally{s.close();}
});
test('moving a parent between sections/projects moves descendants, deleting parent preserves children',()=>{
 const s=new Store(':memory:'); try {
 const p=project(s), q=s.saveEntity('project',{name:'Other',iconType:'color',color:'#123456'});
 const section=s.saveEntity('section',{name:'Doing',projectId:q.id,iconType:'color',color:'#123456'});
 const a=create(s,'A',{projectId:p.id,sectionId:null}), b=create(s,'B',{projectId:p.id,sectionId:null,parentId:a.id}), c=create(s,'C',{parentId:b.id});
 s.mutate(a.id,1,t=>({...t,projectId:q.id,sectionId:section.id}));
 for(const t of s.list()) { assert.equal(t.projectId,q.id); assert.equal(t.sectionId,section.id); }
 s.mutate(b.id,s.get(b.id).revision,()=>null); assert.equal(s.get(c.id).parentId,a.id);
 s.mutate(a.id,s.get(a.id).revision,()=>null); assert.equal(s.get(c.id).parentId,null);
 } finally{s.close();}
});
test('child follows parent placement and cannot be nested beyond ten levels',()=>{
 const s=new Store(':memory:');try{
 let t=create(s,'root'); for(let i=0;i<10;i++) t=create(s,'child',{parentId:t.id});
 assert.throws(()=>create(s,'too deep',{parentId:t.id}),e=>e.status===400);
 }finally{s.close();}
});
test('Markdown formats basic styles and never emits raw HTML or executable links',()=>{
 const html=markdown('**bold** *italic* ~~gone~~ `code` [safe](https://example.com)');
 for(const tag of ['strong','em','del','code','a']) assert.match(html,new RegExp(`<${tag}[ >]`));
 for(const payload of ['<img src=x onerror=alert(1)>','[x](javascript:alert(1))','[x](data:text/html,hello)','[x](javascript&#58;alert)']) {
 const rendered=markdown(payload,true); assert.doesNotMatch(rendered,/<img|href="(?:javascript|data):/); }
 assert.match(markdown('- one\n- two\n\n> quote\n```\n<script>\n```',true),/<ul><li>one<\/li><li>two<\/li><\/ul>/);
 assert.match(markdown('<script>',true),/&lt;script&gt;/);
});
test('JSON round trip preserves hierarchy, description and position; bad graphs are rejected',()=>{
 const s=new Store(':memory:');try{
 const a=create(s,'A',{description:'**note**',position:12}), b=create(s,'B',{parentId:a.id,position:13});
 const document={version:1,tasks:s.list(),history:[]}; const parsed=validateImport(document);
 assert.equal(parsed.tasks.find(t=>t.id===a.id).description,'**note**'); assert.equal(parsed.tasks.find(t=>t.id===b.id).parentId,a.id);
 const target=new Store(':memory:');try{target.importTasks(parsed);assert.equal(target.get(b.id).position,13);}finally{target.close();}
 document.tasks.find(t=>t.id===a.id).parentId=b.id; assert.throws(()=>validateImport(document),e=>e.status===400);
 }finally{s.close();}
});

test('import checks the combined tree when an existing parent has moved deeper',()=>{
 const source=new Store(':memory:'),target=new Store(':memory:');try{
 const parent=create(source,'Parent'), child=create(source,'New child',{parentId:parent.id});
 target.importTasks(validateImport({version:1,tasks:[parent],history:[]}));
 let top=create(target,'Top');for(let i=0;i<9;i++)top=create(target,'Deep',{parentId:top.id});
 move(target,parent,{parentId:top.id});
 assert.throws(()=>target.importTasks(validateImport({version:1,tasks:source.list(),history:[]})),e=>e.status===400);
 assert.equal(target.list().some(t=>t.id===child.id),false);
 }finally{source.close();target.close();}
});

test('attachments enforce size/count and disappear only with their own task',()=>{
 const s=new Store(':memory:');try{
 const task=create(s,'Files');assert.throws(()=>s.addAttachment(task.id,'big',Buffer.alloc(20*1024*1024+1)),e=>e.status===413);
 for(let i=0;i<20;i++)s.addAttachment(task.id,`${i}.txt`,Buffer.from('x'));
 assert.throws(()=>s.addAttachment(task.id,'extra.txt',Buffer.from('x')),e=>e.status===400);
 s.mutate(task.id,task.revision,()=>null);assert.equal(s.db.prepare('SELECT count(*) AS n FROM attachments').get().n,0);
 }finally{s.close();}
});
