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

test('a body of 65537 UTF-8 bytes is rejected with 413 even though it is only 65535 characters', async () => {
  const owner = await spawnMember(server, root, 'limit-bytes-owner');
  const child = await spawnMember(server, owner, 'limit-bytes-child');

  // The limit counts bytes, not characters: 65534 ASCII plus one 3-byte CJK code point.
  const body = 'x'.repeat(65534) + '中';
  assert.equal(new TextEncoder().encode(body).length, 65537, 'the fixture is 65537 UTF-8 bytes');
  assert.equal(body.length, 65535, 'the fixture is shorter than 65537 characters, so only a byte limit rejects it');

  const oversized = await call(server, 'POST', '/v1/messages', {
    token: owner.token,
    body: { to: child.id, body },
    timeoutMs: 10_000,
  });
  assertStatus(oversized, 413, 'POST /v1/messages with a body of 65537 UTF-8 bytes');
  assertErrorCode(oversized, 'payload_too_large', 'POST /v1/messages with a body of 65537 UTF-8 bytes');

  const batch = await poll(server, child);
  assert.deepEqual(batch.items, [], 'the rejected message is not stored or delivered');
});
