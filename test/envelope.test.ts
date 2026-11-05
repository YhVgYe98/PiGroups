import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertOk,
  assertStatus,
  bootstrapRoot,
  call,
  createHuman,
  groupConversation,
  startServer,
  type Reply,
} from './harness.ts';

function assertServerVersion(reply: Reply, what: string): void {
  assert.equal(typeof reply.body?.server_version, 'string', `${what} must carry server_version`);
}

test('GET /v1/health reports status, version, and uptime_ms', async () => {
  const server = await startServer();
  try {
    const health = await call(server, 'GET', '/v1/health');
    assertOk(health, 'GET /v1/health');
    assert.equal(typeof health.body.status, 'string', 'GET /v1/health returns a status string');
    assert.ok(health.body.status.length > 0, 'the health status is not empty');
    assert.equal(typeof health.body.version, 'string', 'GET /v1/health returns a version string');
    assert.equal(typeof health.body.uptime_ms, 'number', 'GET /v1/health returns uptime_ms as a number');
    assert.ok(health.body.uptime_ms >= 0, 'uptime_ms is not negative');
    assertServerVersion(health, 'GET /v1/health');
  } finally {
    await server.stop();
  }
});

test('one response of each endpoint family carries server_version', async () => {
  const server = await startServer();
  try {
    const boot = await call(server, 'POST', '/v1/bootstrap', { body: { name: 'env-root' } });
    assertOk(boot, 'POST /v1/bootstrap');
    assertServerVersion(boot, 'POST /v1/bootstrap');
    const root = { id: boot.body.member.id, token: boot.body.token, name: boot.body.member.name };

    const whoami = await call(server, 'GET', '/v1/whoami', { token: root.token });
    assertOk(whoami, 'GET /v1/whoami');
    assertServerVersion(whoami, 'GET /v1/whoami');

    const created = await call(server, 'POST', '/v1/members', {
      token: root.token,
      body: { name: 'env-child', request_id: 'env-1' },
    });
    assertOk(created, 'POST /v1/members');
    assertServerVersion(created, 'POST /v1/members');
    const child = { id: created.body.member.id, token: created.body.token, name: created.body.member.name };

    const detail = await call(server, 'GET', `/v1/members/${child.id}`, { token: root.token });
    assertOk(detail, 'GET /v1/members/{id}');
    assertServerVersion(detail, 'GET /v1/members/{id}');

    const tree = await call(server, 'GET', '/v1/tree', { token: root.token });
    assertOk(tree, 'GET /v1/tree');
    assertServerVersion(tree, 'GET /v1/tree');

    const conversations = await call(server, 'GET', '/v1/conversations', { token: child.token });
    assertOk(conversations, 'GET /v1/conversations');
    assertServerVersion(conversations, 'GET /v1/conversations');

    const posted = await call(server, 'POST', '/v1/messages', {
      token: root.token,
      body: { to: groupConversation(root.id), body: 'envelope' },
    });
    assertOk(posted, 'POST /v1/messages');
    assertServerVersion(posted, 'POST /v1/messages');

    const history = await call(server, 'GET', '/v1/messages', {
      token: child.token,
      query: { to: groupConversation(root.id) },
    });
    assertOk(history, 'GET /v1/messages');
    assertServerVersion(history, 'GET /v1/messages');

    const polled = await call(server, 'GET', '/v1/poll', {
      token: child.token,
      query: { wait: 0 },
    });
    assertOk(polled, 'GET /v1/poll');
    assertServerVersion(polled, 'GET /v1/poll');

    const control = await call(server, 'POST', '/v1/control', {
      token: root.token,
      body: { to: child.id, id: 'env-ctl', cmd: 'pi.ping' },
    });
    assertOk(control, 'POST /v1/control');
    assertServerVersion(control, 'POST /v1/control');

    const controlListing = await call(server, 'GET', '/v1/control', { token: root.token });
    assertOk(controlListing, 'GET /v1/control');
    assertServerVersion(controlListing, 'GET /v1/control');

    const rotated = await call(server, 'POST', `/v1/members/${child.id}/token`, { token: root.token });
    assertOk(rotated, 'POST /v1/members/{id}/token');
    assertServerVersion(rotated, 'POST /v1/members/{id}/token');

    const deleted = await call(server, 'DELETE', `/v1/members/${child.id}`, { token: root.token });
    assertOk(deleted, 'DELETE /v1/members/{id}');
    assertServerVersion(deleted, 'DELETE /v1/members/{id}');
  } finally {
    await server.stop();
  }
});

test('error responses carry the same server_version as health', async () => {
  const server = await startServer();
  try {
    const health = await call(server, 'GET', '/v1/health');
    assertOk(health, 'GET /v1/health');
    const version = health.body.version;

    const cases: Array<{ what: string; reply: Reply; status: number }> = [
      {
        what: '401 invalid_token',
        reply: await call(server, 'GET', '/v1/whoami', { token: 'not-a-token' }),
        status: 401,
      },
      { what: '404 not_found', reply: await call(server, 'GET', '/v1/no-such-path'), status: 404 },
      {
        what: '400 bad_request',
        reply: await call(server, 'POST', '/v1/bootstrap', { body: { name: 7 } }),
        status: 400,
      },
    ];
    for (const entry of cases) {
      assertStatus(entry.reply, entry.status, entry.what);
      assert.equal(entry.reply.body.server_version, version, `${entry.what} carries the health version`);
      assert.equal(typeof entry.reply.body.error?.code, 'string', `${entry.what} keeps the error envelope`);
    }

    const first = await call(server, 'POST', '/v1/bootstrap', { body: { name: 'env-root' } });
    assertOk(first, 'POST /v1/bootstrap');
    const twice = await call(server, 'POST', '/v1/bootstrap', { body: { name: 'another' } });
    assertStatus(twice, 409, '409 already_bootstrapped');
    assert.equal(twice.body.server_version, version, '409 carries the health version');
  } finally {
    await server.stop();
  }
});

test('bootstrap, member creation and heartbeat have exact envelope keys', async () => {
  const server = await startServer();
  try {
    const boot = await call(server, 'POST', '/v1/bootstrap', { body: { name: 'keys-root' } });
    assertOk(boot, 'POST /v1/bootstrap');
    assert.deepEqual(
      Object.keys(boot.body).sort(),
      ['member', 'server_version', 'token'],
      'bootstrap answers member, token, server_version',
    );
    const root = { id: boot.body.member.id, token: boot.body.token, name: boot.body.member.name };

    const created = await call(server, 'POST', '/v1/members', {
      token: root.token,
      body: { name: 'keys-child', request_id: 'keys-1' },
    });
    assertOk(created, 'POST /v1/members');
    assert.deepEqual(
      Object.keys(created.body).sort(),
      ['member', 'server_version', 'token'],
      'member creation answers member, token, server_version',
    );

    const replay = await call(server, 'POST', '/v1/members', {
      token: root.token,
      body: { name: 'keys-child', request_id: 'keys-1' },
    });
    assertOk(replay, 'POST /v1/members replay');
    assert.deepEqual(
      Object.keys(replay.body).sort(),
      ['member', 'server_version'],
      'a replay carries no plaintext token',
    );

    const beat = await call(server, 'PUT', `/v1/members/${created.body.member.id}/heartbeat`, {
      token: created.body.token,
    });
    assertOk(beat, 'PUT heartbeat');
    assert.deepEqual(
      Object.keys(beat.body).sort(),
      ['heartbeat_at', 'server_version'],
      'heartbeat answers only the timestamp',
    );
  } finally {
    await server.stop();
  }
});

test('whoami has the documented member and human shapes, and no derived liveness', async () => {
  const server = await startServer();
  try {
    const root = await bootstrapRoot(server);
    const member = await call(server, 'GET', '/v1/whoami', { token: root.token });
    assertOk(member, 'GET /v1/whoami (member)');
    assert.deepEqual(
      Object.keys(member.body).sort(),
      ['dms', 'groups', 'kind', 'last_seen_at', 'member', 'server', 'server_version'],
      'member whoami keys',
    );
    assert.deepEqual(
      Object.keys(member.body.member).sort(),
      [
        'child_count',
        'created_at',
        'groups',
        'heartbeat_at',
        'id',
        'is_root',
        'last_seen_at',
        'name',
        'parent_id',
        'status',
      ],
      'member view keys',
    );
    assert.deepEqual(Object.keys(member.body.server).sort(), ['platform_id', 'version'], 'server block keys');

    const human = await createHuman(server, 'keys-human');
    const asHuman = await call(server, 'GET', '/v1/whoami', { token: human.token });
    assertOk(asHuman, 'GET /v1/whoami (human)');
    assert.deepEqual(
      Object.keys(asHuman.body).sort(),
      ['conversations', 'human', 'kind', 'last_seen_at', 'server', 'server_version'],
      'human whoami keys',
    );

    for (const reply of [member, asHuman]) {
      assert.equal('online' in reply.body, false, 'the platform derives no online flag');
      assert.equal('unread' in reply.body, false, 'the platform derives no unread count');
    }
  } finally {
    await server.stop();
  }
});
