import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function entrypoint(env) {
  const dir = mkdtempSync(join(tmpdir(), 'fly-entrypoint-'));
  try {
    // Do not change host ownership or require root in the unit tests.
    for (const name of ['mkdir', 'chown', 'chmod'])
      writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(dir, 'runuser'), '#!/bin/sh\nprintf "%s\\n" "${PUBLIC_URL:-}" "$*"\n', { mode: 0o755 });
    return spawnSync('sh', ['scripts/fly-entrypoint.sh', 'node', 'server.mjs'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        PUBLIC_URL: '', FLY_APP_NAME: '', ...env },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('native Fly launch derives HTTPS public URL and drops Node privileges', () => {
  const r = entrypoint({ FLY_APP_NAME: 'gateway-test-123' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'https://gateway-test-123.fly.dev\n-u node -- node server.mjs\n');
});
test('custom PUBLIC_URL takes precedence', () => {
  const r = entrypoint({ FLY_APP_NAME: 'gateway-test', PUBLIC_URL: 'https://gateway.example.com' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.startsWith('https://gateway.example.com\n'));
});
test('non-Fly Docker use leaves public URL unset', () => {
  const r = entrypoint({});
  assert.equal(r.status, 0);
  assert.ok(r.stdout.startsWith('\n'));
});
test('rejects malformed app names rather than creating an unsafe origin', () => {
  for (const name of ['bad/path', 'bad.example', '-bad', 'bad-', 'bad name', 'bad;name'])
    assert.notEqual(entrypoint({ FLY_APP_NAME: name }).status, 0);
});
test('README button targets provider launcher, not GitHub Actions', () => {
  const readme = readFileSync('README.md', 'utf8');
  assert.match(readme, /\[!\[Deploy to Fly\.io\][^\n]+\]\(https:\/\/fly\.io\/dashboard\/personal\/new\)/);
  assert.match(readme, /does \*\*not\*\* preselect the repo/);
  const config = readFileSync('fly.toml', 'utf8');
  assert.match(config, /initial_size = "1gb"/);
  assert.match(config, /destination = "\/data"/);
});
