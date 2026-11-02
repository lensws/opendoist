import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const base = 'http://localhost:32991';
const login = await fetch(`${base}/api/login`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:readFileSync(process.argv[3],'utf8')})});
assert.equal(login.status,200,'Installer must preserve the password exactly');
const headers = {'Content-Type':'application/json', Cookie:login.headers.get('set-cookie').split(';')[0]};
if (process.argv[2] === 'create') {
  const response = await fetch(`${base}/api/tasks`,{method:'POST',headers,body:JSON.stringify({source:'Installer persistence check'})});
  assert.equal(response.status,201);
} else {
  const response = await fetch(`${base}/api/tasks`,{headers}); assert.equal(response.status,200);
  assert.ok((await response.json()).tasks.some(t => t.title === 'Installer persistence check'));
}
console.log('Installer smoke check passed');
