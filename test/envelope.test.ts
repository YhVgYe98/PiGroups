import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertOk,
  bootstrapRoot,
  call,
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
