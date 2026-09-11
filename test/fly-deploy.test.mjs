import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function deploy(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fly-deploy-'));
  try {
    writeFileSync(join(dir, 'flyctl'), `#!/usr/bin/env python3
import os, sys, json
args = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as f: f.write(json.dumps(args) + '\\n')
if args[:2] == ['apps', 'list']:
    if os.environ.get('FAIL_LIST'): sys.exit(1)
    print(os.environ.get('APPS', '[]'))
elif args[:2] == ['volumes', 'list']: print(os.environ.get('VOLUMES', '[]'))
elif args[:2] == ['ips', 'list']: print(os.environ.get('IPS', '[]'))
`, { mode: 0o755 });
    const result = spawnSync('bash', ['scripts/deploy-fly.sh'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: join(dir, 'calls'),
        FLY_API_TOKEN: 'test-only', FLY_APP: 'test-gateway', FLY_REGION: 'ams', FLY_ORG: 'personal',
        GITHUB_STEP_SUMMARY: join(dir, 'summary'), ...overrides },
    });
    let calls = [];
    try { calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse); } catch {}
    return { ...result, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('first deployment provisions storage and IPs, disables HA', () => {
  const r = deploy();
  assert.equal(r.status, 0, r.stderr);
  for (const prefix of [['apps', 'create'], ['volumes', 'create'], ['ips', 'allocate-v6'], ['ips', 'allocate-v4']])
    assert.ok(r.calls.some(c => c.slice(0, 2).join() === prefix.join()));
  const command = r.calls.find(c => c[0] === 'deploy');
  assert.ok(command.includes('--ha=false'));
  assert.ok(command.includes('PUBLIC_URL=https://test-gateway.fly.dev'));
});

test('updates reuse resources', () => {
  const r = deploy({ APPS: '[{"Name":"test-gateway"}]',
    VOLUMES: '[{"name":"gateway_data","region":"ams"}]', IPS: '[{"Type":"v6"},{"Type":"shared_v4"}]' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some(c => c.includes('create') || c.some(a => a.startsWith('allocate-'))));
});

for (const [name, env] of Object.entries({
  'wrong region': { VOLUMES: '[{"name":"gateway_data","region":"iad"}]' },
  'duplicate volumes': { VOLUMES: '[{"name":"gateway_data","region":"ams"},{"name":"gateway_data","region":"ams"}]' },
  'API failure': { FAIL_LIST: '1' },
  'malformed API response': { APPS: 'invalid json' },
  'shell injection': { FLY_APP: 'app; touch /tmp/nope' },
  'missing token': { FLY_API_TOKEN: '' },
})) test(`refuses ${name}`, () => {
  const r = deploy(env);
  assert.notEqual(r.status, 0);
  assert.ok(!r.calls.some(c => c[0] === 'deploy'));
  if (env.FAIL_LIST || env.APPS) assert.ok(!r.calls.some(c => c.includes('create')));
});
