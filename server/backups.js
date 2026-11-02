import { backup } from 'node:sqlite';
import { mkdir, mkdtemp, chmod, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { AppError } from './store.js';
const intervals = { hourly:3600000, daily:86400000, weekly:604800000 };
export function publicBackup(config, running = false) {
  const { accessKeyId, secretAccessKey, ...safe } = config;
  return { ...safe, hasCredentials:!!(accessKeyId && secretAccessKey), running };
}
export function validateBackup(body, previous, now = Date.now()) {
  const next = { ...previous };
  const keys = ['enabled','target','frequency','folder','endpoint','region','bucket','prefix','accessKeyId','secretAccessKey','forcePathStyle'];
  if (Object.keys(body).some(k => !keys.includes(k))) throw new AppError(400, 'Неизвестная настройка копирования');
  for (const key of keys) if (body[key] !== undefined && (!['accessKeyId','secretAccessKey'].includes(key) || body[key] !== '')) next[key] = body[key];
  if (typeof next.enabled !== 'boolean' || typeof next.forcePathStyle !== 'boolean' || !['folder','s3'].includes(next.target) || !intervals[next.frequency]) throw new AppError(400, 'Проверьте место и частоту копирования');
  for (const key of ['folder','endpoint','region','bucket','prefix','accessKeyId','secretAccessKey']) if (typeof next[key] !== 'string' || next[key].length > 1024 || /[\x00-\x1f\x7f]/.test(next[key])) throw new AppError(400, 'Некорректные параметры копирования');
  if (!isAbsolute(next.folder) || next.folder.split(/[\\/]/).includes('..')) throw new AppError(400, 'Укажите абсолютный путь к папке');
  if (next.endpoint) { try { const url = new URL(next.endpoint); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error(); } catch { throw new AppError(400, 'S3 endpoint должен быть HTTPS-адресом без пути и пароля'); } }
  if (next.target === 's3' && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(next.bucket) || !/^[a-z0-9-]{1,60}$/.test(next.region) || !next.accessKeyId || !next.secretAccessKey || !/^[a-zA-Z0-9/_-]*$/.test(next.prefix))) throw new AppError(400, 'Укажите bucket, регион и оба ключа S3; префикс — буквы, цифры, /, _ или -');
  next.nextRun = next.enabled ? (previous.enabled && previous.frequency === next.frequency ? previous.nextRun || now + intervals[next.frequency] : now + intervals[next.frequency]) : null;
  return next;
}
export async function uploadS3(config, file, key) {
  const client = new S3Client({ region:config.region, ...(config.endpoint ? { endpoint:config.endpoint } : {}), forcePathStyle:config.forcePathStyle, credentials:{ accessKeyId:config.accessKeyId, secretAccessKey:config.secretAccessKey }, maxAttempts:2 });
  const body = createReadStream(file);
  try { await client.send(new PutObjectCommand({ Bucket:config.bucket, Key:key, Body:body, ContentLength:(await stat(file)).size, ContentType:'application/vnd.sqlite3' }), { abortSignal:AbortSignal.timeout(120000) }); }
  finally { body.destroy(); client.destroy(); }
}
export class BackupWorker {
  constructor(store, { database, upload = uploadS3 } = {}) { this.store = store; this.directory = dirname(resolve(database || './data/opendoist.sqlite')); this.upload = upload; this.pending = null; }
  config() { return { enabled:false, target:'folder', frequency:'daily', folder:join(this.directory, 'backups'), endpoint:'', region:'us-east-1', bucket:'', prefix:'opendoist/', accessKeyId:'', secretAccessKey:'', forcePathStyle:true, nextRun:null, lastSuccess:null, lastAttempt:null, lastError:null, ...this.store.backupConfig() }; }
  status() { return publicBackup(this.config(), !!this.pending); }
  save(body) { if (this.pending) throw new AppError(409, 'Дождитесь завершения копирования'); const config = validateBackup(body, this.config()); this.store.saveBackupConfig(config); return this.status(); }
  run() {
    if (this.pending) throw new AppError(409, 'Копирование уже выполняется');
    const config = validateBackup({}, this.config()), now = Date.now();
    this.store.saveBackupConfig({ ...config, lastAttempt:now, lastError:null, nextRun:config.enabled ? now + intervals[config.frequency] : null });
    this.pending = this.perform(config).then(location => {
      this.store.saveBackupConfig({ ...this.config(), lastSuccess:Date.now(), lastLocation:location, lastError:null });
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
  async stop() { clearInterval(this.timer); await this.pending; }
}
