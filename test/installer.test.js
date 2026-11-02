import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const installer = 'install/install.sh';
const functions = readFileSync(installer, 'utf8').split('\nmain "$@"')[0];
test('installer offers help and rejects unsafe arguments before privileged actions', () => {
  assert.equal(spawnSync('bash',[installer,'--help']).status,0);
  for (const args of [['--no-such-option'],['--dir'],['--dir','/'],['--dir','/tmp/../etc'],['--ref','main;id'],['--port','0'],['--port','65536'],['--port','1;id'],['--domain','https://example.org'],['--domain','evil.org { admin off }']]) {
    const result=spawnSync('bash',[installer,...args],{encoding:'utf8'});
    assert.equal(result.status,1); assert.match(result.stderr,/Ошибка:/);
  }
});
test('installer escapes dotenv secrets without shell expansion', () => {
  const password = 'test-only $HOME ${VAR} "quotes" \\backslash\' end';
  const result = spawnSync('bash',['-c',functions+'\ndotenv_value "$1"','installer-test',password],{encoding:'utf8'});
  assert.equal(result.status,0);
  assert.equal(result.stdout, '"'+password.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('$','\\$')+'"');
  assert.equal(result.stderr,'');
});
test('installer validates DNS hostnames rather than Caddy configuration fragments', () => {
  for (const [domain, valid] of [['todo.example.org',true],['xn--e1afmkfd.xn--p1ai',true],['a.example.org;id',false],['*.example.org',false],['example.org/path',false],['example.org\nlocalhost',false],['-bad.example.org',false]]) {
    const result=spawnSync('bash',['-c',functions+'\nvalid_domain "$1"','installer-test',domain]);
    assert.equal(result.status,valid?0:1);
  }
});
