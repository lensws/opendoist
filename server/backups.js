import { pruneFolder, pruneS3 } from './backup-retention.js';
import { backup } from 'node:sqlite';
import { mkdir, mkdtemp, chmod, rename, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { AppError } from './store.js';
const intervals = { hourly:3600000, daily:86400000, weekly:604800000 };
export function publicBackup(config, running = false) {
  const { accessKeyId, secretAccessKey, ...safe } = config;
  return { ...safe, hasCredentials:!!(accessKeyId && secretAccessKey), running };
}
export function validateBackup(body, previous, now = Date.now()) {
  const next = { retentionDays:30, ...previous };
  const keys = ['enabled','target','frequency','folder','endpoint','region','bucket','prefix','accessKeyId','secretAccessKey','forcePathStyle','retentionDays'];
  if (Object.keys(body).some(k => !keys.includes(k))) throw new AppError(400, 'Неизвестная настройка копирования');
  for (const key of keys) if (body[key] !== undefined && (!['accessKeyId','secretAccessKey'].includes(key) || body[key] !== '')) next[key] = body[key];
  if (typeof next.enabled !== 'boolean' || typeof next.forcePathStyle !== 'boolean' || !['folder','s3'].includes(next.target) || !intervals[next.frequency]) throw new AppError(400, 'Проверьте место и частоту копирования');
  if (!Number.isInteger(next.retentionDays) || next.retentionDays < 1 || next.retentionDays > 3650) throw new AppError(400, 'Срок хранения — целое число от 1 до 3650 дней');
  for (const key of ['folder','endpoint','region','bucket','prefix','accessKeyId','secretAccessKey']) if (typeof next[key] !== 'string' || next[key].length > 1024 || /[\x00-\x1f\x7f]/.test(next[key])) throw new AppError(400, 'Некорректные параметры копирования');
  if (!isAbsolute(next.folder) || next.folder.split(/[\\/]/).includes('..')) throw new AppError(400, 'Укажите абсолютный путь к папке');
  if (next.endpoint) { try { const url = new URL(next.endpoint); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error(); } catch { throw new AppError(400, 'S3 endpoint должен быть HTTPS-адресом без пути и пароля'); } }
  if (next.target === 's3' && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(next.bucket) || !/^[a-z0-9-]{1,60}$/.test(next.region) || !next.accessKeyId || !next.secretAccessKey || !/^[a-zA-Z0-9/_-]*$/.test(next.prefix))) throw new AppError(400, 'Укажите bucket, регион и оба ключа S3; префикс — буквы, цифры, /, _ или -');
  next.nextRun = next.enabled ? (previous.enabled && previous.frequency === next.frequency ? previous.nextRun || now + intervals[next.frequency] : now + intervals[next.frequency]) : null;
  return next;
}
function s3Client(config) {
  return new S3Client({ region:config.region, ...(config.endpoint ? { endpoint:config.endpoint } : {}), forcePathStyle:config.forcePathStyle, credentials:{ accessKeyId:config.accessKeyId, secretAccessKey:config.secretAccessKey }, maxAttempts:2 });
}
export async function uploadS3(config, file, key) {
  const client = s3Client(config);
  const body = createReadStream(file);
  try { await client.send(new PutObjectCommand({ Bucket:config.bucket, Key:key, Body:body, ContentLength:(await stat(file)).size, ContentType:'application/vnd.sqlite3' }), { abortSignal:AbortSignal.timeout(120000) }); }
  finally { body.destroy(); client.destroy(); }
}
export async function pruneBackups(config, current) {
  if(config.target==='folder') return pruneFolder(config,current);
  const client=s3Client(config);
  try{return await pruneS3(config,current,client);}finally{client.destroy();}
}
// Only random test data is sent; no task or backup contents leave the server.
export async function testBackupDestination(config, createClient = s3Client) {
  const content = `OpenDoist connection check ${randomUUID()}`;
  let stage = 'write', cleanupFailed = false, failure = null;
  if (config.target === 'folder') {
    let temporary;
    try {
      await mkdir(config.folder, { recursive:true, mode:0o700 });
      temporary = await mkdtemp(join(config.folder, '.opendoist-check-'));
      const draft = join(temporary, 'check.tmp'), file = join(temporary, 'check.txt');
      await writeFile(draft, content, { mode:0o600, flag:'wx' });
      await rename(draft, file); stage = 'read';
      if (await readFile(file, 'utf8') !== content) throw Error('Mismatch');
    } catch { failure = stage; }
    finally { if (temporary) try { await rm(temporary, { recursive:true, force:true }); } catch { cleanupFailed = true; } }
  } else {
    const client = createClient(config);
    const key = `${config.prefix.replace(/\/$/,'')}${config.prefix ? '/' : ''}opendoist-check-${randomUUID()}.txt`;
    const object = { Bucket:config.bucket, Key:key }, signal = AbortSignal.timeout(20000);
    let uploaded = false;
    try {
      await client.send(new PutObjectCommand({ ...object, Body:content, ContentType:'text/plain', IfNoneMatch:'*' }), { abortSignal:signal });
      uploaded = true; stage = 'read';
      const response = await client.send(new GetObjectCommand(object), { abortSignal:signal });
      if (await response.Body.transformToString() !== content) throw Error('Mismatch');
      stage='list';
      await client.send(new ListObjectsV2Command({Bucket:config.bucket,Prefix:config.prefix.replace(/\/$/,'')+(config.prefix?'/':''),MaxKeys:1}),{abortSignal:signal});
    } catch { failure = stage; }
    finally {
      if (uploaded) try { await client.send(new DeleteObjectCommand(object), { abortSignal:AbortSignal.timeout(10000) }); } catch { cleanupFailed = true; }
      client.destroy();
    }
  }
  const destination = config.target === 's3' ? 'S3' : 'папку';
  if (failure) return { ok:false, message:failure === 'list' ? 'Запись и чтение прошли, но список копий недоступен. Для очистки добавьте право s3:ListBucket на выбранный префикс.' : failure === 'write' ? `Не удалось записать тестовые данные в ${destination}. Проверьте ${config.target === 's3' ? 'endpoint, регион, bucket, ключи, право s3:PutObject и сеть' : 'путь, права на запись и свободное место'}.` : `Запись прошла, но чтение тестовых данных не подтверждено. Проверьте ${config.target === 's3' ? 'право s3:GetObject и настройки шифрования bucket' : 'права на чтение папки'}.`, warning:cleanupFailed ? 'Не удалось удалить тестовые данные. Проверьте право на удаление.' : failure === 'write' && config.target === 's3' ? 'Если соединение прервалось после записи, в bucket мог остаться объект opendoist-check-*.txt.' : null };
  return { ok:true, message:'Подключение проверено: тестовые данные записаны и прочитаны без изменений.', warning:cleanupFailed ? `Тестовые данные не удалены. ${config.target === 's3' ? 'Добавьте право s3:DeleteObject или удалите объект opendoist-check-*.txt вручную.' : 'Проверьте права на удаление в папке.'}` : null };
}
export class BackupWorker {
  constructor(store, { database, upload = uploadS3, testDestination = testBackupDestination, cleanup = pruneBackups } = {}) { this.store = store; this.directory = dirname(resolve(database || './data/opendoist.sqlite')); this.upload = upload; this.pending = null; this.testing = null; this.testDestination = testDestination; this.cleanup=cleanup; }
  config() { return { enabled:false, target:'folder', frequency:'daily', retentionDays:30, lastCleanupError:null, lastCleanup:null, folder:join(this.directory, 'backups'), endpoint:'', region:'us-east-1', bucket:'', prefix:'opendoist/', accessKeyId:'', secretAccessKey:'', forcePathStyle:true, nextRun:null, lastSuccess:null, lastAttempt:null, lastError:null, ...this.store.backupConfig() }; }
  status() { return publicBackup(this.config(), !!this.pending); }
  save(body) { if (this.pending) throw new AppError(409, 'Дождитесь завершения копирования'); const config = validateBackup(body, this.config()); this.store.saveBackupConfig(config); return this.status(); }
  async test(body) {
    if (this.testing) throw new AppError(409, 'Проверка уже выполняется');
    const config = validateBackup(body, this.config());
    this.testing = Promise.resolve().then(() => this.testDestination(config));
    try { return await this.testing; }
    catch { throw new AppError(502, 'Не удалось проверить хранилище. Проверьте параметры и доступность сервера.'); }
    finally { this.testing = null; }
  }
  run() {
    if (this.pending) throw new AppError(409, 'Копирование уже выполняется');
    const config = validateBackup({}, this.config()), now = Date.now();
    this.store.saveBackupConfig({ ...config, lastAttempt:now, lastError:null, nextRun:config.enabled ? now + intervals[config.frequency] : null });
    this.pending = this.perform(config).then(async location => {
      this.store.saveBackupConfig({ ...this.config(), lastSuccess:Date.now(), lastLocation:location, lastError:null });
      try {
        const removed=await this.cleanup(config,location);
        this.store.saveBackupConfig({...this.config(),lastCleanup:Date.now(),lastRemoved:removed,lastCleanupError:null});
      } catch {
        this.store.saveBackupConfig({...this.config(),lastCleanupError:config.target==='s3' ? 'Копия создана, но очистка старых копий не завершена. Проверьте s3:ListBucket, s3:DeleteObject, Object Lock и доступность S3.' : 'Копия создана, но очистка старых копий не завершена. Проверьте права папки.'});
      }
    }).catch(() => {
      // Provider errors can contain credentials or signed URLs. Never expose them.
      this.store.saveBackupConfig({ ...this.config(), lastError:config.target === 's3' ? 'Не удалось отправить в S3. Проверьте endpoint, ключи, права bucket и сеть.' : 'Не удалось сохранить копию. Проверьте права папки и свободное место.' });
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async perform(config) {
    const directory = config.target === 'folder' ? resolve(config.folder) : this.directory;
    await mkdir(directory, { recursive:true, mode:0o700 });
    // A private temporary directory on the same filesystem allows atomic publication.
    const temporary = await mkdtemp(join(directory, '.opendoist-backup-'));
    const file = join(temporary, 'snapshot.sqlite');
    const name = `opendoist-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.sqlite`;
    try {
      await backup(this.store.db, file); await chmod(file, 0o600);
      if (config.target === 's3') { const key = `${config.prefix.replace(/\/$/,'')}${config.prefix ? '/' : ''}${name}`; await this.upload(config, file, key); return `s3://${config.bucket}/${key}`; }
      const target = join(directory, name); await rename(file, target); return target;
    } finally { await rm(temporary, { recursive:true, force:true }); }
  }
  tick(now = Date.now()) { const config = this.config(); if (config.enabled && config.nextRun <= now && !this.pending) return this.run(); }
  start() { this.timer = setInterval(() => { try { this.tick(); } catch { /* Status remains available in settings. */ } }, 30000); this.timer.unref(); this.tick(); }
  async stop() { clearInterval(this.timer); await Promise.allSettled([this.pending, this.testing]); }
}
