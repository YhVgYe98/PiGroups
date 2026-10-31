import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertErrorCode,
  assertStatus,
  bootstrapRoot,
  call,
  poll,
  sendControl,
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

test('a drained gone member is 410 on writes and on whoami, never 401', async () => {
  const owner = await spawnMember(server, root, 'gone-owner');
  const child = await spawnMember(server, owner, 'gone-child');

  const deleted = await call(server, 'DELETE', `/v1/members/${child.id}`, { token: owner.token });
  assertStatus(deleted, 200, `DELETE /v1/members/${child.id}`);

  const notice = await poll(server, child);
  assert.equal(notice.items.length, 1, 'the terminated member drains its termination notice first');
  assert.equal(notice.items[0].cmd, 'sys.terminated', 'the drained item is the termination notice');

  const write = await call(server, 'POST', '/v1/messages', {
    token: child.token,
    body: { to: owner.id, body: 'still here' },
  });
  assertStatus(write, 410, 'a gone member posting a message');
  assertErrorCode(write, 'member_gone', 'a gone member posting a message');

  const instruction = await call(server, 'POST', '/v1/control', {
    token: child.token,
    body: { to: owner.id, id: 'gone-write-1', cmd: 'pi.report' },
  });
  assertStatus(instruction, 410, 'a gone member sending an instruction');
  assertErrorCode(instruction, 'member_gone', 'a gone member sending an instruction');

  const whoami = await call(server, 'GET', '/v1/whoami', { token: child.token });
  assertStatus(whoami, 410, 'GET /v1/whoami with a gone member token');
  assertErrorCode(whoami, 'member_gone', 'GET /v1/whoami with a gone member token');
});

test('deleting a subtree purges pending receipts, so the first poll carries only sys.terminated', async () => {
  const owner = await spawnMember(server, root, 'purge-owner');
  const child = await spawnMember(server, owner, 'purge-child');

  const pending = await sendControl(server, owner, child.id, 'purge-1', 'pi.pending');
  assert.equal(pending.receipts[0].state, 'pending', 'the instruction is left pending before the delete');

  const deleted = await call(server, 'DELETE', `/v1/members/${owner.id}`, { token: root.token });
  assertStatus(deleted, 200, `DELETE /v1/members/${owner.id}`);
  assert.deepEqual(
    [...deleted.body.terminated].sort(),
    [owner.id, child.id].sort(),
    'the whole subtree is terminated',
  );

  const batch = await poll(server, child);
  assert.equal(batch.items.length, 1, 'the first poll after the delete carries exactly one item');
  assert.equal(batch.items[0].kind, 'control', 'the remaining item is on the control channel');
  assert.equal(batch.items[0].cmd, 'sys.terminated', 'the pending instruction was purged, leaving only the notice');
  assert.equal(batch.items[0].from_id, 'sys', 'the notice comes from the platform');
  assert.equal(batch.control_pending, 0, 'nothing is left pending after the notice is drained');

  const drained = await call(server, 'GET', '/v1/poll', { token: child.token, query: { wait: 0 } });
  assertStatus(drained, 410, 'polling the terminated member after the only item was consumed');
  assertErrorCode(drained, 'member_gone', 'polling the terminated member after the only item was consumed');
});
