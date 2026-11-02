import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('SSH deployment command rejects shell injection and arbitrary revisions', () => {
  for (const input of ['', 'main', 'abc', 'a'.repeat(40) + '; id', '$(id)', '-'.repeat(40), 'A'.repeat(40)]) {
    const result = spawnSync('/bin/sh', ['deploy/automation/ssh-command.sh', 'main'], { env: { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: input }, encoding: 'utf8' });
    assert.equal(result.status, 64, input);
  }
});
test('SSH deployment command binds a valid SHA to its key-specific branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendoist-ssh-test-'));
  try {
    writeFileSync(join(dir, 'sudo'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const sha = 'a'.repeat(40);
    for (const branch of ['main', 'beta']) {
      const result = spawnSync('/bin/sh', ['deploy/automation/ssh-command.sh', branch], { env: { PATH: dir, SSH_ORIGINAL_COMMAND: sha }, encoding: 'utf8' });
      assert.equal(result.status, 0);
      assert.deepEqual(result.stdout.trim().split('\n'), ['-n', '/usr/local/sbin/opendoist-deploy', branch, sha]);
    }
    const invalid = spawnSync('/bin/sh', ['deploy/automation/ssh-command.sh', 'other'], { env: { PATH: dir, SSH_ORIGINAL_COMMAND: sha } });
    assert.equal(invalid.status, 64);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('privileged deployment entry rejects invalid branch and SHA before doing work', () => {
  for (const args of [[], ['main'], ['main', 'abc'], ['unknown', 'a'.repeat(40)], ['main', 'a'.repeat(40), 'extra']]) {
    assert.equal(spawnSync('/bin/bash', ['deploy/automation/deploy.sh', ...args]).status, 64);
  }
});
