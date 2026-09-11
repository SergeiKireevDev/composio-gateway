import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../composio.mjs';

test('connected services are user-scoped, active-only and paginated', async () => {
  const queries = [];
  const provider = createProvider({ makeClient: () => ({ connectedAccounts: {
    async list(query) {
      queries.push(query);
      return query.cursor
        ? { items: [{ status: 'ACTIVE', toolkit: { slug: 'github' } }], nextCursor: null }
        : { items: [
            { status: 'ACTIVE', toolkit: { slug: 'gmail' } },
            { status: 'EXPIRED', toolkit: { slug: 'slack' } },
          ], nextCursor: 'next' };
    },
  } }) });
  assert.deepEqual(await provider.connectedToolkits('key', 'alice'), ['gmail', 'github']);
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.deepEqual(query.userIds, ['alice']);
    assert.deepEqual(query.statuses, ['ACTIVE']);
  }
  assert.equal(queries[1].cursor, 'next');
});
