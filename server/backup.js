import { DatabaseSync, backup } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
const source = resolve(process.env.DATABASE_PATH || './data/opendoist.sqlite');
const target = process.argv[2] && resolve(process.argv[2]);
if (!target || source === target || existsSync(target) || !existsSync(source)) throw new Error('Use a new destination file: node server/backup.js /path/to/backup.sqlite');
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, target); console.log('SQLite backup created.'); } finally { db.close(); }
