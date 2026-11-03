import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
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


test('main deploys both isolated production targets; beta stays independent; failures roll back only the failing target', () => {
  for (const scenario of ['main', 'beta', 'failure', 'stale']) {
    const dir = mkdtempSync(join(tmpdir(), 'opendoist-release-test-'));
    try {
      const sha = 'a'.repeat(40), previous = 'b'.repeat(40);
      for (const tier of ['prod', 'enki', 'beta']) mkdirSync(join(dir, tier));
      const mock = `#!/bin/bash
printf '%s %s\\n' "$(basename "$0")" "$*" >> '${dir}/calls'
case "$(basename "$0")" in
 git)
   case "$*" in
     *rev-parse*refs/remotes*) echo '${scenario === 'stale' ? previous : sha}' ;;
     *rev-parse*) echo '${previous}' ;;
   esac ;;
 docker)
   case "$*" in
     *inspect*) echo old-image ;;
     *'ps -q'*) echo container ;;
     *'opendoist-enki up'*)
       if [[ '${scenario}' == failure && ! -e '${dir}/failed' ]]; then touch '${dir}/failed'; exit 1; fi ;;
   esac ;;
esac
`;
      for (const command of ['git', 'docker', 'curl', 'flock', 'install', 'chmod', 'find']) writeFileSync(join(dir, command), mock, {mode:0o700});
      // Redirect only privileged environment/paths; execute the real release logic with mocked tools.
      const script = readFileSync('deploy/automation/deploy.sh', 'utf8')
        .replace('export PATH=/usr/sbin:/usr/bin:/sbin:/bin', `export PATH='${dir}':/usr/bin:/bin`)
        .replace('[[ $EUID == 0 ]] || exit 77', ':')
        .replaceAll('/opt/opendoist/', `${dir}/`)
        .replace('/run/lock/opendoist-deploy.lock', `${dir}/lock`);
      writeFileSync(join(dir, 'release.sh'), script);
      const result = spawnSync('/bin/bash', [join(dir, 'release.sh'), scenario === 'beta' ? 'beta' : 'main', sha], {encoding:'utf8'});
      assert.equal(result.status, scenario === 'failure' ? 1 : 0, result.stderr);
      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      if (scenario === 'stale') { assert.doesNotMatch(calls, /docker /); continue; }
      const tiers = scenario === 'beta' ? ['beta'] : ['prod', 'enki'];
      for (const tier of tiers) {
        assert.match(calls, new RegExp(`docker compose --project-name opendoist-${tier} build`));
        assert.match(calls, new RegExp(`/var/backups/opendoist/${tier}/`));
      }
      if (scenario === 'beta') assert.doesNotMatch(calls, /opendoist-(prod|enki)/);
      else {
        assert.ok(calls.indexOf('opendoist-prod up') < calls.indexOf('opendoist-enki up'));
        assert.doesNotMatch(calls, /opendoist-beta/);
      }
      if (scenario === 'failure') {
        assert.doesNotMatch(calls, /find .*enki/);
        assert.match(calls, /docker image tag old-image opendoist-enki-opendoist:latest/);
        assert.doesNotMatch(calls, /docker image tag old-image opendoist-prod/);
        assert.match(calls, new RegExp(`checkout --quiet --detach ${previous}`));
      } else { for(const tier of tiers) assert.match(calls,new RegExp(`find /var/backups/opendoist/${tier} .* -mmin \\+43200 -delete`)); assert.match(calls, /https:\/\//); }
    } finally { rmSync(dir, {recursive:true, force:true}); }
  }
});
