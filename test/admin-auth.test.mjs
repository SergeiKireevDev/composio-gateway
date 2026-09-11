import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createGateway } from '../server.mjs';
import { loadAdminTokenHash, matchesTokenHash } from '../store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-admin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function start(dir, adminToken) {
  const app = createGateway({ dataDir: dir, adminToken });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return { app, request: async token => (await fetch(`http://127.0.0.1:${app.server.address().port}/api/admin/status`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  })).status };
}

test('persists only a private hash; authenticates original token, not verifier', async t => {
  const dir = directory(t);
  const secret = 'test-only-random-token-1234567890';
  const { app, request } = await start(dir, secret);
  try {
    assert.equal(readFileSync(join(dir, 'admin.token.sha256'), 'utf8'), digest(secret) + '\n');
    assert.equal(existsSync(join(dir, 'admin.token')), false);
    assert.equal(statSync(join(dir, 'admin.token.sha256')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const file of readdirSync(dir)) assert.equal(readFileSync(join(dir, file)).includes(Buffer.from(secret)), false);
    assert.equal(await request(secret), 200);
    for (const invalid of [undefined, '', 'wrong', digest(secret), 'x'.repeat(10000)])
      assert.equal(await request(invalid), 401);
  } finally { await app.close(); }
});

test('hash survives restart without environment input; new token rotates it', async t => {
  const dir = directory(t);
  let active = await start(dir, 'original-admin');
  await active.app.close();
  active = await start(dir);
  assert.equal(await active.request('original-admin'), 200);
  await active.app.close();
  active = await start(dir, 'replacement-admin');
  try {
    assert.equal(await active.request('original-admin'), 401);
    assert.equal(await active.request('replacement-admin'), 200);
  } finally { await active.app.close(); }
});

test('migrates old token without changing login; no fallback when hash exists', async t => {
  const dir = directory(t);
  writeFileSync(join(dir, 'admin.token'), ' legacy-admin\n');
  const active = await start(dir);
  try {
    assert.equal(await active.request('legacy-admin'), 200);
    assert.equal(existsSync(join(dir, 'admin.token')), false);
  } finally { await active.app.close(); }
  writeFileSync(join(dir, 'admin.token'), 'stale-legacy');
  const saved = loadAdminTokenHash(dir);
  assert.ok(matchesTokenHash('legacy-admin', saved));
  assert.equal(matchesTokenHash('stale-legacy', saved), false);
  assert.equal(existsSync(join(dir, 'admin.token')), false);
});

test('environment overrides legacy value and invalid hash', t => {
  const dir = directory(t);
  writeFileSync(join(dir, 'admin.token'), 'old');
  writeFileSync(join(dir, 'admin.token.sha256'), 'corrupt');
  assert.ok(matchesTokenHash('new', loadAdminTokenHash(dir, 'new')));
  assert.equal(existsSync(join(dir, 'admin.token')), false);
});

test('fresh install fails closed; invalid input never silently falls back', t => {
  const dir = directory(t);
  assert.throws(() => createGateway({ dataDir: dir }), /Set ADMIN_TOKEN/);
  assert.equal(existsSync(join(dir, 'admin.token')), false);
  loadAdminTokenHash(dir, 'valid');
  for (const value of ['', '  ', null, 7])
    assert.throws(() => createGateway({ dataDir: dir, adminToken: value }), /must not be empty/);
  assert.equal(readFileSync(join(dir, 'admin.token.sha256'), 'utf8').trim(), digest('valid'));
  for (const value of ['', 'xyz', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(65)]) {
    writeFileSync(join(dir, 'admin.token.sha256'), value);
    writeFileSync(join(dir, 'admin.token'), 'legacy');
    assert.throws(() => createGateway({ dataDir: dir }), /Invalid admin.token.sha256/);
    assert.ok(existsSync(join(dir, 'admin.token')));
  }
});

test('failed hash replacement preserves the legacy token and cleans temporary file', t => {
  const dir = directory(t);
  writeFileSync(join(dir, 'admin.token'), 'legacy');
  mkdirSync(join(dir, 'admin.token.sha256'));
  assert.throws(() => loadAdminTokenHash(dir, 'new'));
  assert.equal(readFileSync(join(dir, 'admin.token'), 'utf8'), 'legacy');
  assert.equal(readdirSync(dir).some(p => p.endsWith('.tmp')), false);
});

test('environment token is hashed byte-for-byte, not trimmed', t => {
  const dir = directory(t);
  const saved = loadAdminTokenHash(dir, ' spaced ');
  assert.ok(matchesTokenHash(' spaced ', saved));
  assert.equal(matchesTokenHash('spaced', saved), false);
});
