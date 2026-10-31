import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertErrorCode,
  assertStatus,
  bootstrapRoot,
  call,
  groupConversation,
  poll,
  sendMessage,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a hanging poll wakes on a new message well before its wait elapses', async () => {
  const owner = await spawnMember(server, root, 'wake-msg-owner');
  const child = await spawnMember(server, owner, 'wake-msg-child');

  const startedAt = Date.now();
  const hanging = call(server, 'GET', '/v1/poll', {
    token: child.token,
    query: { wait: 10 },
    timeoutMs: 15_000,
  });
  await sleep(100);
  const posted = await sendMessage(server, owner, groupConversation(owner.id), 'wake up');

  const reply = await hanging;
  const elapsedMs = Date.now() - startedAt;
  assertStatus(reply, 200, 'a hanging poll woken by a new message');
  assert.ok(elapsedMs < 2_000, `the poll was woken after ${elapsedMs}ms, so it did not wait for its timeout`);
  const delivered = reply.body.items.find((item: any) => item.kind === 'message' && item.seq === posted.seq);
  assert.ok(delivered, 'the woke poll carries the message that woke it');
  assert.equal(delivered.to, groupConversation(owner.id), 'the woken message names its conversation');
});

test('a hanging poll wakes with sys.terminated when a delete terminates the member', async () => {
  const owner = await spawnMember(server, root, 'wake-del-owner');
  const victim = await spawnMember(server, owner, 'wake-del-victim');

  const startedAt = Date.now();
  const hanging = call(server, 'GET', '/v1/poll', {
    token: victim.token,
    query: { wait: 10 },
    timeoutMs: 15_000,
  });
  await sleep(100);
  const deleted = await call(server, 'DELETE', `/v1/members/${victim.id}`, { token: owner.token });
  assertStatus(deleted, 200, `DELETE /v1/members/${victim.id}`);

  const reply = await hanging;
  const elapsedMs = Date.now() - startedAt;
  assertStatus(reply, 200, 'a hanging poll woken by a termination notice');
  assert.ok(elapsedMs < 2_000, `the poll was woken after ${elapsedMs}ms, so the delete woke it`);
  assert.equal(reply.body.items.length, 1, 'the woken poll carries exactly the termination notice');
  assert.equal(reply.body.items[0].kind, 'control', 'the termination notice arrives on the control channel');
  assert.equal(reply.body.items[0].cmd, 'sys.terminated', 'the notice is sys.terminated');
  assert.equal(reply.body.items[0].from_id, 'sys', 'the notice comes from the platform');
});

test('a second poll while one is hanging is 409 poll_in_progress carrying Retry-After: 1, and a non-retryable 409 carries none', async () => {
  const owner = await spawnMember(server, root, 'single-owner');
  const child = await spawnMember(server, owner, 'single-child');

  const hanging = call(server, 'GET', '/v1/poll', {
    token: child.token,
    query: { wait: 5 },
    timeoutMs: 10_000,
  });
  await sleep(150);

  const second = await call(server, 'GET', '/v1/poll', { token: child.token, query: { wait: 0 } });
  assertStatus(second, 409, 'a second poll from the member that already has one hanging');
  assertErrorCode(second, 'poll_in_progress', 'a second poll from the member that already has one hanging');
  assert.equal(
    second.headers['retry-after'],
    '1',
    'poll_in_progress tells the adapter to retry after one second',
  );

  await sendMessage(server, owner, groupConversation(owner.id), 'release the hanging poll');
  const released = await hanging;
  assertStatus(released, 200, 'the first poll still completes normally after the 409');

  // The retry hint belongs to poll_in_progress alone; another 409 must not carry it.
  const rootDelete = await call(server, 'DELETE', `/v1/members/${root.id}`, { token: root.token });
  assertStatus(rootDelete, 409, 'DELETE of the root');
  assertErrorCode(rootDelete, 'root_protected', 'DELETE of the root');
  assert.equal(
    rootDelete.headers['retry-after'],
    undefined,
    'root_protected is not retryable, so it carries no Retry-After',
  );
});

test('poll clamps limit:999 and wait:-1 instead of rejecting them, and rejects an unknown types value', async () => {
  const owner = await spawnMember(server, root, 'clamp-owner');
  const child = await spawnMember(server, owner, 'clamp-child');

  await sendMessage(server, owner, groupConversation(owner.id), 'c1');
  await sendMessage(server, owner, groupConversation(owner.id), 'c2');
  await sendMessage(server, owner, groupConversation(owner.id), 'c3');

  const hugeLimit = await poll(server, child, { limit: 999 });
  const delivered = hugeLimit.items.filter((item: any) => item.kind === 'message');
  assert.equal(delivered.length, 3, 'limit:999 is clamped rather than rejected, and the three messages come back');

  const startedAt = Date.now();
  const negativeWait = await call(server, 'GET', '/v1/poll', {
    token: child.token,
    query: { wait: -1 },
    timeoutMs: 5_000,
  });
  const elapsedMs = Date.now() - startedAt;
  assertStatus(negativeWait, 200, 'poll with wait:-1');
  assert.ok(elapsedMs < 2_000, `wait:-1 must clamp to 0, but the poll took ${elapsedMs}ms`);

  const unknownType = await call(server, 'GET', '/v1/poll', {
    token: child.token,
    query: { wait: 0, types: 'messages' },
  });
  assertStatus(unknownType, 400, 'poll with an unknown types value');
  assertErrorCode(unknownType, 'bad_request', 'poll with an unknown types value');

  const controlOnly = await poll(server, child, { types: 'control' });
  assert.deepEqual(controlOnly.items, [], 'the invalid types poll did not consume anything');
});
