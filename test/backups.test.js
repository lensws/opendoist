import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { BackupWorker, validateBackup, publicBackup } from '../server/backups.js';
async function setup(t, upload) {
 const dir=await mkdtemp(join(tmpdir(),'opendoist-backup-test-')); const database=join(dir,'db.sqlite'); const store=new Store(database), worker=new BackupWorker(store,{database,upload});
 t.after(async()=>{await worker.stop();store.close();await rm(dir,{recursive:true,force:true});}); return {dir,store,worker};
}
test('folder snapshot restores tasks, files and settings; schedule survives restart',async t=>{
 const {dir,store,worker}=await setup(t); const task=store.create({title:'Snapshot',description:'**hello**'});
 store.addAttachment(task.id,'hello.txt',Buffer.from('bytes')); store.saveSettings({theme:'dark'});
 worker.save({enabled:true,frequency:'hourly',folder:join(dir,'copies')}); const next=worker.config().nextRun;
 assert.equal(new BackupWorker(store,{database:join(dir,'db.sqlite')}).config().nextRun,next);
 await worker.tick(next-1); assert.equal(worker.config().lastSuccess,null);
 await worker.tick(next); assert.ok(worker.config().lastSuccess); assert.equal(worker.config().lastError,null);
 const file=worker.config().lastLocation; assert.equal((await stat(file)).mode & 0o777,0o600);
 const restored=new Store(file);try{assert.equal(restored.get(task.id).description,'**hello**');assert.equal(restored.attachments(task.id)[0].name,'hello.txt');assert.equal(Buffer.from(restored.db.prepare('SELECT data FROM attachments').get().data).toString(),'bytes');assert.equal(restored.settings().theme,'dark');}finally{restored.close();}
 assert.ok(!(await readdir(join(dir,'copies'))).some(n=>n.startsWith('.opendoist-backup-')));
});
test('S3 receives complete SQLite snapshot; keys are redacted and failures are safe',async t=>{
 let fail=false, captured;
 const {dir,worker}=await setup(t,async(config,file,key)=>{captured={header:(await readFile(file)).subarray(0,16).toString(),key};if(fail)throw Error(`secret: ${config.secretAccessKey}`);});
 worker.save({target:'s3',enabled:true,bucket:'test-bucket',region:'us-east-1',endpoint:'https://storage.example.com',accessKeyId:'test-key',secretAccessKey:'test-secret'});
 const safe=worker.status(); assert.equal(safe.hasCredentials,true); assert.equal(safe.secretAccessKey,undefined); assert.equal(safe.accessKeyId,undefined);
 worker.save({secretAccessKey:'',accessKeyId:''}); assert.equal(worker.config().secretAccessKey,'test-secret');
 await worker.run(); assert.match(captured.header,/SQLite format 3/); assert.match(captured.key,/^opendoist\/.*\.sqlite$/); assert.match(worker.config().lastLocation,/^s3:\/\/test-bucket\//);
 fail=true; await worker.run(); assert.match(worker.status().lastError,/Не удалось/); assert.doesNotMatch(JSON.stringify(worker.status()),/test-secret/);
 assert.ok(!(await readdir(dir)).some(n=>n.startsWith('.opendoist-backup-')));
});
test('overlapping backups are rejected and disabled schedule does not run',async t=>{
 let release; const gate=new Promise(r=>release=r); const {worker}=await setup(t,()=>gate);
 worker.save({target:'s3',bucket:'test-bucket',accessKeyId:'key',secretAccessKey:'secret'});
 assert.equal(worker.tick(Date.now()+999999999),undefined);
 const pending=worker.run(); assert.throws(()=>worker.run(),e=>e.status===409); assert.throws(()=>worker.save({enabled:true}),e=>e.status===409); release(); await pending;
});
test('backup configuration rejects unsafe or invalid values',async t=>{
 const {worker}=await setup(t); const config=worker.config();
 for(const body of [{frequency:'minutely'},{folder:'relative'},{folder:'/a/../b'},{endpoint:'http://storage.example.com'},{endpoint:'https://user:pass@storage.example.com'},{target:'s3',bucket:'bad bucket'},{enabled:'yes'},{unknown:true}]) assert.throws(()=>validateBackup(body,config),e=>e.status===400);
 assert.equal(publicBackup({...config,secretAccessKey:'hidden'}).secretAccessKey,undefined);
});

test('destination test uses unsaved folder, cleans up and preserves config',async t=>{
 const {dir,store,worker}=await setup(t);worker.save({enabled:true,frequency:'weekly'});const before=store.backupConfig();
 const folder=join(dir,'draft');const result=await worker.test({folder});assert.equal(result.ok,true);assert.equal(result.warning,null);assert.deepEqual(await readdir(folder),[]);assert.deepEqual(store.backupConfig(),before);
 assert.equal((await worker.test({folder:join(dir,'db.sqlite','invalid')})).ok,false);
});
test('S3 check verifies data and cleanup without exposing provider errors',async()=>{
 const {testBackupDestination}=await import('../server/backups.js');
 for(const failAt of [null,'PutObjectCommand','GetObjectCommand','DeleteObjectCommand','mismatch']){
 let content,destroyed=false;const commands=[];
 const result=await testBackupDestination({target:'s3',prefix:'custom/',bucket:'test'},()=>({send:async command=>{
 commands.push(command);const type=command.constructor.name;if(type===failAt)throw Error('private provider details');
 if(type==='PutObjectCommand')content=command.input.Body;
 if(type==='GetObjectCommand')return {Body:{transformToString:async()=>failAt==='mismatch' ? 'wrong' : content}};
 return {};
 },destroy:()=>{destroyed=true;}}));
 assert.equal(destroyed,true);assert.doesNotMatch(JSON.stringify(result),/private provider details/);assert.equal(result.ok,failAt===null||failAt==='DeleteObjectCommand');
 assert.equal(new Set(commands.map(c=>c.input.Key)).size,1);assert.match(commands[0].input.Key,/^custom\/opendoist-check-.*\.txt$/);assert.equal(commands[0].input.IfNoneMatch,'*');
 if(failAt!=='PutObjectCommand')assert.ok(commands.some(c=>c.constructor.name==='DeleteObjectCommand'));
 if(failAt==='DeleteObjectCommand')assert.match(result.warning,/DeleteObject/);
 if(failAt===null){assert.equal(result.warning,null);assert.match(content,/^OpenDoist connection check /);}
 }
});
test('concurrent checks rejected; blank draft keys use saved credentials without saving draft',async t=>{
 const {store,dir}=await setup(t);let release,tested;
 const worker=new BackupWorker(store,{database:join(dir,'db.sqlite'),testDestination:async config=>{tested=config;await new Promise(r=>release=r);return {ok:true};}});
 worker.save({target:'s3',bucket:'saved-bucket',accessKeyId:'test-id',secretAccessKey:'test-only-key'});
 const pending=worker.test({bucket:'draft-bucket',accessKeyId:'',secretAccessKey:''});await Promise.resolve();await assert.rejects(worker.test({}),e=>e.status===409);release();
 assert.equal((await pending).ok,true);assert.equal(tested.bucket,'draft-bucket');assert.equal(tested.secretAccessKey,'test-only-key');assert.equal(worker.config().bucket,'saved-bucket');
});
