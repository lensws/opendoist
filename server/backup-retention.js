import { readdir, lstat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
// Exact application filenames only: never traverse subdirectories or delete foreign files.
export function backupTimestamp(name) {
  const match=/^opendoist-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/.exec(name);
  return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : NaN;
}
export async function pruneFolder(config, current, now=Date.now()) {
  const cutoff=now-config.retentionDays*86400000;
  let removed=0;
  for(const name of await readdir(config.folder)) {
    if(!(backupTimestamp(name)<cutoff))continue;
    const file=join(config.folder,name);
    if(resolve(file)===resolve(current))continue;
    const info=await lstat(file);
    if(!info.isFile() || info.mtimeMs>=cutoff)continue;
    await unlink(file);removed++;
  }
  return removed;
}
export async function pruneS3(config,current,client,now=Date.now()) {
  const prefix=config.prefix.replace(/\/$/,'')+(config.prefix?'/':'');
  const cutoff=now-config.retentionDays*86400000, keys=[], tokens=new Set();
  let token,removed=0;
  // Finish listing before deleting, so pagination is not disturbed by our deletions.
  do {
    const page=await client.send(new ListObjectsV2Command({Bucket:config.bucket,Prefix:prefix,ContinuationToken:token}),{abortSignal:AbortSignal.timeout(30000)});
    for(const object of page.Contents || []) {
      const key=object.Key;
      if(!key?.startsWith(prefix) || `s3://${config.bucket}/${key}`===current)continue;
      if(backupTimestamp(key.slice(prefix.length))<cutoff && new Date(object.LastModified).getTime()<cutoff)keys.push(key);
    }
    token=page.IsTruncated?page.NextContinuationToken:undefined;
    if(page.IsTruncated && (!token || tokens.has(token)))throw Error('Invalid S3 pagination');
    tokens.add(token);
  }while(token);
  for(const Key of keys){await client.send(new DeleteObjectCommand({Bucket:config.bucket,Key}),{abortSignal:AbortSignal.timeout(30000)});removed++;}
  return removed;
}
