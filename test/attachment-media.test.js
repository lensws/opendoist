import test from 'node:test';
import assert from 'node:assert/strict';
import { serveAttachment } from '../server/attachment-media.js';

test('cached media and HEAD do not read the attachment blob', () => {
  const file={id:'file-id',name:'photo.png',size:2400000};
  for(const [method,headers,status] of [
    ['GET',{'if-none-match':'"attachment-file-id-preview"'},304],
    ['HEAD',{},200],
  ]) {
    let actualStatus,body;
    serveAttachment({url:'/file?preview=1',method,headers},{writeHead(code){actualStatus=code;},end(value){body=value;}},file,{},()=>{throw Error('Unexpected blob read');});
    assert.equal(actualStatus,status);assert.equal(body,undefined);
  }
});
