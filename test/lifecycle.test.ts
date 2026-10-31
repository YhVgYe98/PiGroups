import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertErrorCode,
  assertOk,
  assertStatus,
  bootstrapRoot,
  call,
  poll,
  spawnMember,
  startServer,
  type Principal,
  type Server,
} from './harness.ts';

let server: Server;
let root: Principal;

before(async () => {
  server = await startServer();
  root = await bootstrapRoot(server);
});

after(async () => {
  if (server) await server.stop();
});

test('deleting a member removes the whole subtree, and its next poll returns 410 once the termination notice is consumed', async () => {
  const owner = await spawnMember(server, root, 'life-owner');
  const child = await spawnMember(server, owner, 'life-child');
  const grandchild = await spawnMember(server, child, 'life-grandchild');

  const deleted = await call(server, 'DELETE', `/v1/members/${owner.id}`, { token: root.token });
  assertOk(deleted, `DELETE /v1/members/${owner.id}`);
  assert.deepEqual(
    [...deleted.body.terminated].sort(),
    [owner.id, child.id, grandchild.id].sort(),
    'the whole subtree is terminated, the target included',
  );

  for (const id of [owner.id, child.id, grandchild.id]) {
    const detail = await call(server, 'GET', `/v1/members/${id}`, { token: root.token });
    assertOk(detail, `GET /v1/members/${id} after the deletion`);
    assert.equal(detail.body.status, 'gone', `${id} is gone after the subtree delete`);
  }

  const notice = await poll(server, owner);
  assert.equal(notice.items.length, 1, 'a deleted member has exactly the termination notice waiting');
  assert.equal(notice.items[0].kind, 'control', 'the termination notice arrives on the control channel');
  assert.equal(notice.items[0].cmd, 'sys.terminated', 'the termination notice is sys.terminated');
  assert.equal(notice.items[0].from_id, 'sys', 'the termination notice comes from the platform');
  assert.ok(notice.items[0].payload && typeof notice.items[0].payload === 'object', 'the notice carries a payload');
  assert.ok('reason' in notice.items[0].payload, 'the notice payload says why');
  assert.ok('terminated_by' in notice.items[0].payload, 'the notice payload says who terminated it');

  const afterNotice = await call(server, 'GET', '/v1/poll', { token: owner.token, query: { wait: 0 } });
  assertStatus(afterNotice, 410, 'polling a deleted member once its notice is consumed');
  assertErrorCode(afterNotice, 'member_gone', 'polling a deleted member once its notice is consumed');
});

test('a direct child of a deleted member also gets 410', async () => {
  const owner = await spawnMember(server, root, 'child410-owner');
  const child = await spawnMember(server, owner, 'child410-child');

  const deleted = await call(server, 'DELETE', `/v1/members/${owner.id}`, { token: root.token });
  assertOk(deleted, `DELETE /v1/members/${owner.id}`);

  const notice = await poll(server, child);
  assert.equal(notice.items.length, 1, 'the child of the deleted member has its termination notice waiting');
  assert.equal(notice.items[0].kind, 'control', 'the notice arrives on the control channel');
  assert.equal(notice.items[0].cmd, 'sys.terminated', 'the child is told it was terminated');
  assert.equal(notice.items[0].from_id, 'sys', 'the notice comes from the platform');

  const afterNotice = await call(server, 'GET', '/v1/poll', { token: child.token, query: { wait: 0 } });
  assertStatus(afterNotice, 410, 'polling the child of a deleted member once its notice is consumed');
  assertErrorCode(afterNotice, 'member_gone', 'polling the child of a deleted member once its notice is consumed');
});
