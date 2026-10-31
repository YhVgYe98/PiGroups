import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertErrorCode,
  assertOk,
  assertStatus,
  bootstrapRoot,
  call,
  dmConversation,
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

function sortedSeqs(items: any[]): number[] {
  return items.map((item) => item.seq).sort((a: number, b: number) => a - b);
}

test('GET /v1/messages returns the newest limit messages, next pages backwards until it is null, and a bare peer id is the same DM', async () => {
  const owner = await spawnMember(server, root, 'hist-owner');
  const reader = await spawnMember(server, owner, 'hist-reader');
  const peer = await spawnMember(server, owner, 'hist-peer');
  const group = groupConversation(owner.id);

  const posted: number[] = [];
  for (const text of ['one', 'two', 'three', 'four', 'five']) {
    posted.push((await sendMessage(server, owner, group, text)).seq);
  }
  assert.deepEqual(posted, [1, 2, 3, 4, 5], 'five messages obtain seq 1..5 in one group conversation');

  const newest = await call(server, 'GET', '/v1/messages', {
    token: reader.token,
    query: { to: group, limit: 2 },
  });
  assertOk(newest, 'GET /v1/messages without before');
  assert.deepEqual(sortedSeqs(newest.body.items), [4, 5], 'without before the newest limit messages come back');
  assert.ok(
    newest.body.items.every((item: any) => item.to === group),
    'every history item names the conversation it was read from',
  );
  assert.equal(newest.body.next, 4, 'next is the before value that continues behind the oldest returned message');

  const middle = await call(server, 'GET', '/v1/messages', {
    token: reader.token,
    query: { to: group, limit: 2, before: newest.body.next },
  });
  assertOk(middle, 'GET /v1/messages with before=next');
  assert.deepEqual(sortedSeqs(middle.body.items), [2, 3], 'before is exclusive, so the next page is the two before it');
  assert.equal(middle.body.next, 2, 'the next cursor keeps moving back by the oldest returned seq');

  const oldest = await call(server, 'GET', '/v1/messages', {
    token: reader.token,
    query: { to: group, limit: 2, before: middle.body.next },
  });
  assertOk(oldest, 'GET /v1/messages one page before the end');
  assert.deepEqual(sortedSeqs(oldest.body.items), [1], 'walking next reaches the first message of the conversation');
  assert.equal(oldest.body.next, null, 'next is null once there is nothing older to page to');

  const dmFromPeer = await sendMessage(server, peer, reader.id, 'dm from peer');
  const dmFromReader = await sendMessage(server, reader, peer.id, 'dm from reader');
  assert.equal(dmFromPeer.to, dmConversation(peer.id, reader.id), 'the DM conversation id is dm:<a>_<b>');
  assert.equal(dmFromReader.to, dmFromPeer.to, 'both directions land in the same DM conversation');

  const byConversation = await call(server, 'GET', '/v1/messages', {
    token: reader.token,
    query: { to: dmFromPeer.to },
  });
  assertOk(byConversation, 'GET /v1/messages?to=dm:<a>_<b>');
  const byPeer = await call(server, 'GET', '/v1/messages', {
    token: reader.token,
    query: { to: peer.id },
  });
  assertOk(byPeer, 'GET /v1/messages?to=<bare peer id>');

  const shape = 'items that read the same DM through two wire forms must be the same items';
  assert.deepEqual(
    byPeer.body.items.map((item: any) => [item.to, item.seq, item.sender_id, item.body]).sort(),
    byConversation.body.items.map((item: any) => [item.to, item.seq, item.sender_id, item.body]).sort(),
    shape,
  );
  assert.deepEqual(
    byConversation.body.items.map((item: any) => item.seq).sort(),
    [1, 2],
    'the DM conversation history holds both messages',
  );
});

test('a group history stays readable after its last child is deleted, and its seq keeps counting when the group reappears', async () => {
  const owner = await spawnMember(server, root, 'reappear-owner');
  const first = await spawnMember(server, owner, 'reappear-first');
  const group = groupConversation(owner.id);

  const firstPost = await sendMessage(server, owner, group, 'before the group disappeared');
  assert.equal(firstPost.seq, 1, 'the group conversation starts at seq 1');

  const deleted = await call(server, 'DELETE', `/v1/members/${first.id}`, { token: owner.token });
  assertStatus(deleted, 200, `DELETE /v1/members/${first.id}`);
  const assertEmpty = await call(server, 'POST', '/v1/messages', {
    token: owner.token,
    body: { to: group, body: 'the group is gone' },
  });
  assertStatus(assertEmpty, 404, 'posting to the group after its last child was deleted');
  assertErrorCode(assertEmpty, 'no_such_group', 'posting to the group after its last child was deleted');

  const history = await call(server, 'GET', '/v1/messages', { token: owner.token, query: { to: group } });
  assertStatus(history, 200, 'reading the history of a group that no longer exists');
  assert.deepEqual(sortedSeqs(history.body.items), [1], 'a disappeared group still exposes its history');

  const second = await spawnMember(server, owner, 'reappear-second');
  assert.equal(typeof second.id, 'string', 'a new child makes the owner group exist again');
  const secondPost = await sendMessage(server, owner, group, 'after the group reappeared');
  assert.equal(
    secondPost.seq,
    firstPost.seq + 1,
    'conversation numbering is never recycled when the same group reappears',
  );

  const later = await call(server, 'GET', '/v1/messages', { token: owner.token, query: { to: group } });
  assertOk(later, 'GET /v1/messages after the group reappeared');
  assert.deepEqual(sortedSeqs(later.body.items), [1, 2], 'both the old and the new message are readable');

  const childView = await poll(server, second);
  const delivered = childView.items.filter((item: any) => item.kind === 'message');
  assert.equal(delivered.length, 1, 'the new child is delivered only the message sent after it existed');
  assert.equal(delivered[0].seq, secondPost.seq, 'delivery is a snapshot taken when the member exists');
});
