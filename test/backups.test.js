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
