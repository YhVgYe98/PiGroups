import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertErrorCode,
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

test('a message body over 64 KiB is rejected with 413 payload_too_large and not stored', async () => {
  const owner = await spawnMember(server, root, 'limit-owner');
  const child = await spawnMember(server, owner, 'limit-child');

  const oversized = await call(server, 'POST', '/v1/messages', {
    token: owner.token,
    body: { to: child.id, body: 'x'.repeat(64 * 1024 + 1) },
    timeoutMs: 10_000,
  });
  assertStatus(oversized, 413, 'POST /v1/messages with a body over 64 KiB');
  assertErrorCode(oversized, 'payload_too_large', 'POST /v1/messages with a body over 64 KiB');

  const batch = await poll(server, child);
  assert.deepEqual(batch.items, [], 'the rejected message is not stored or delivered');
});
