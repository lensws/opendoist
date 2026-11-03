import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, readFile, writeFile, utimes, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { BackupWorker, validateBackup, publicBackup } from '../server/backups.js';
async function setup(t, upload) {
 const dir=await mkdtemp(join(tmpdir(),'opendoist-backup-test-')); const database=join(dir,'db.sqlite'); const store=new Store(database), worker=new BackupWorker(store,{database,upload,...(upload ? {cleanup:async()=>0} : {})});
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
 const {worker}=await setup(t); const config=worker.config(); assert.equal(config.retentionDays,30); storeLegacy();
 function storeLegacy(){const {retentionDays,...legacy}=config;worker.store.saveBackupConfig(legacy);assert.equal(worker.config().retentionDays,30);}
 for(const body of [{retentionDays:0},{retentionDays:-1},{retentionDays:1.5},{retentionDays:'30'},{retentionDays:3651},{frequency:'minutely'},{folder:'relative'},{folder:'/a/../b'},{endpoint:'http://storage.example.com'},{endpoint:'https://user:pass@storage.example.com'},{target:'s3',bucket:'bad bucket'},{enabled:'yes'},{unknown:true}]) assert.throws(()=>validateBackup(body,config),e=>e.status===400);
 assert.equal(publicBackup({...config,secretAccessKey:'hidden'}).secretAccessKey,undefined);
});

test('destination test uses unsaved folder, cleans up and preserves config',async t=>{
 const {dir,store,worker}=await setup(t);worker.save({enabled:true,frequency:'weekly'});const before=store.backupConfig();
 const folder=join(dir,'draft');const result=await worker.test({folder});assert.equal(result.ok,true);assert.equal(result.warning,null);assert.deepEqual(await readdir(folder),[]);assert.deepEqual(store.backupConfig(),before);
 assert.equal((await worker.test({folder:join(dir,'db.sqlite','invalid')})).ok,false);
});
test('S3 check verifies data and cleanup without exposing provider errors',async()=>{
 const {testBackupDestination}=await import('../server/backups.js');
 for(const failAt of [null,'PutObjectCommand','GetObjectCommand','DeleteObjectCommand','ListObjectsV2Command','mismatch']){
 let content,destroyed=false;const commands=[];
 const result=await testBackupDestination({target:'s3',prefix:'custom/',bucket:'test'},()=>({send:async command=>{
 commands.push(command);const type=command.constructor.name;if(type===failAt)throw Error('private provider details');
 if(type==='PutObjectCommand')content=command.input.Body;
 if(type==='GetObjectCommand')return {Body:{transformToString:async()=>failAt==='mismatch' ? 'wrong' : content}};
 return {};
 },destroy:()=>{destroyed=true;}}));
 assert.equal(destroyed,true);assert.doesNotMatch(JSON.stringify(result),/private provider details/);assert.equal(result.ok,failAt===null||failAt==='DeleteObjectCommand');
 assert.equal(new Set(commands.filter(c=>c.input.Key).map(c=>c.input.Key)).size,1);assert.match(commands[0].input.Key,/^custom\/opendoist-check-.*\.txt$/);assert.equal(commands[0].input.IfNoneMatch,'*');
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


test('folder TTL deletes only expired backups, preserving current backup, foreign files and symlinks',async t=>{
 const {dir,worker}=await setup(t); const folder=join(dir,'copies');await mkdir(folder);
 const old='opendoist-2020-01-01T00-00-00-000Z-11111111-1111-1111-1111-111111111111.sqlite';
 const link=old.replace('2020-01-01','2020-01-02'),directory=old.replace('2020-01-01','2020-01-03'),fresh=old.replace('2020-01-01','2020-01-04');
 await writeFile(join(folder,old),'old');await utimes(join(folder,old),new Date('2020-01-01'),new Date('2020-01-01'));
 await writeFile(join(folder,'manual.sqlite'),'manual');await symlink(join(folder,'manual.sqlite'),join(folder,link));await mkdir(join(folder,directory));await writeFile(join(folder,fresh),'recently replaced');
 worker.save({folder,retentionDays:7});await worker.run();
 const names=await readdir(folder);assert.ok(!names.includes(old));for(const name of ['manual.sqlite',link,directory,fresh])assert.ok(names.includes(name));
 assert.ok(names.includes(worker.config().lastLocation.split('/').pop()));assert.equal(worker.status().lastRemoved,1);assert.equal(worker.status().lastCleanupError,null);
 assert.equal(worker.config().retentionDays,7);
});
test('S3 retention lists all pages before deleting only expired direct-prefix backups',async()=>{
 const {pruneS3}=await import('../server/backup-retention.js');
 const name='opendoist-2020-01-01T00-00-00-000Z-11111111-1111-1111-1111-111111111111.sqlite';
 const calls=[];let page=0;
 const config={bucket:'test',prefix:'mine/',retentionDays:30};
 const client={send:async command=>{calls.push(command);if(command.constructor.name==='ListObjectsV2Command'){
 page++;return page===1?{IsTruncated:true,NextContinuationToken:'page2',Contents:[{Key:'mine/'+name,LastModified:new Date('2020-01-01')},{Key:'other/'+name,LastModified:new Date('2020-01-01')},{Key:'mine/sub/'+name,LastModified:new Date('2020-01-01')}]}:{Contents:[{Key:'mine/'+name.replace('2020','2022'),LastModified:new Date('2020-01-01')},{Key:'mine/manual.sqlite',LastModified:new Date('2020-01-01')},{Key:'mine/'+name.replace('2020','2021'),LastModified:new Date()}]};
 }return {};}};
 assert.equal(await pruneS3(config,'s3://test/mine/'+name.replace('2020','2022'),client),1);
 assert.deepEqual(calls.map(c=>c.constructor.name),['ListObjectsV2Command','ListObjectsV2Command','DeleteObjectCommand']);
 assert.equal(calls[1].input.ContinuationToken,'page2');assert.equal(calls[2].input.Key,'mine/'+name);
});
test('failed backup never prunes; cleanup failure preserves successful backup and redacts provider errors',async t=>{
 const {dir,store}=await setup(t);let cleanups=0,failUpload=true;
 const worker=new BackupWorker(store,{database:join(dir,'db.sqlite'),upload:async()=>{if(failUpload)throw Error('secret');},cleanup:async()=>{cleanups++;throw Error('secret');}});
 worker.save({target:'s3',bucket:'test-bucket',accessKeyId:'key',secretAccessKey:'secret'});
 await worker.run();assert.equal(cleanups,0);assert.equal(worker.config().lastSuccess,null);
 failUpload=false;await worker.run();assert.equal(cleanups,1);assert.ok(worker.config().lastSuccess);assert.equal(worker.config().lastError,null);assert.match(worker.status().lastCleanupError,/очистка/);assert.doesNotMatch(worker.status().lastCleanupError,/secret/);
 worker.cleanup=async()=>2;await worker.run();assert.equal(worker.status().lastCleanupError,null);assert.equal(worker.status().lastRemoved,2);
});
test('retention defaults to 30 days for existing configurations and respects the exact cutoff',async()=>{
 const {pruneS3}=await import('../server/backup-retention.js');
 const now=Date.parse('2026-11-04T12:00:00Z');const base='-11111111-1111-1111-1111-111111111111.sqlite';const deleted=[];
 const names=['opendoist-2026-10-05T12-00-00-000Z'+base,'opendoist-2026-10-05T11-59-59-000Z'+base];
 const client={send:async c=>{if(c.constructor.name==='ListObjectsV2Command')return {Contents:names.map(Key=>({Key,LastModified:new Date('2020-01-01')}))};deleted.push(c.input.Key);return {};}};
 await pruneS3({bucket:'test',prefix:'',retentionDays:30},'s3://test/current',client,now);assert.deepEqual(deleted,[names[1]]);
});
