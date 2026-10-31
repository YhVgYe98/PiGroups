import test from 'node:test';
import assert from 'node:assert/strict';

import { assertErrorCode, assertOk, assertStatus, call, startServer } from './harness.ts';

test('bootstrap creates the root, a second bootstrap is 409, and an unknown token is 401', async () => {
  const server = await startServer();
  try {
    const created = await call(server, 'POST', '/v1/bootstrap', { body: { name: 'root' } });
    assertOk(created, 'POST /v1/bootstrap on an empty workspace');
    assert.match(
      String(created.body?.member?.id),
      /^m_[0-9a-f]{6}$/,
      `POST /v1/bootstrap: member id must look like m_<6 hex>, got ${JSON.stringify(created.body?.member?.id)}`,
    );
    assert.equal(created.body.member.parent_id, null, 'the first member is the root, so it has no parent');
    assert.equal(created.body.member.is_root, true, 'the first member is flagged as the root');
    assert.equal(typeof created.body.token, 'string', 'POST /v1/bootstrap returns a token');
    assert.ok(created.body.token.length > 0, 'the bootstrap token is not empty');

    const second = await call(server, 'POST', '/v1/bootstrap', { body: { name: 'root-again' } });
    assertStatus(second, 409, 'POST /v1/bootstrap on a workspace that already has a root');
    assertErrorCode(second, 'already_bootstrapped', 'POST /v1/bootstrap on a workspace that already has a root');

    const unknown = await call(server, 'GET', '/v1/whoami', { token: 'definitely-not-a-real-token' });
    assertStatus(unknown, 401, 'GET /v1/whoami with an unrecognised token');
    assertErrorCode(unknown, 'invalid_token', 'GET /v1/whoami with an unrecognised token');

    const anonymous = await call(server, 'GET', '/v1/whoami');
    assertStatus(anonymous, 401, 'GET /v1/whoami without a token');
    assertErrorCode(anonymous, 'invalid_token', 'GET /v1/whoami without a token');
  } finally {
    await server.stop();
  }
});
