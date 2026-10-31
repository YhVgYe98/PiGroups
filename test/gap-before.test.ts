import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertOk,
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

test('a gap for a conversation with no retained message anchors at newest skipped seq + 1 and counts the mentions inside it', async () => {
  const owner = await spawnMember(server, root, 'gap2-owner');
  const reader = await spawnMember(server, owner, 'gap2-reader');
  const firstPeer = await spawnMember(server, owner, 'gap2-first-peer');
  const secondPeer = await spawnMember(server, owner, 'gap2-second-peer');
  const group = groupConversation(owner.id);
  const firstDm = dmConversation(reader.id, firstPeer.id);
  const secondDm = dmConversation(reader.id, secondPeer.id);

  // Two older group deliveries (the reader keeps none of them), then two newer DMs.
  await sendMessage(server, owner, group, 'skipped and mentioned', { mentions: [reader.id] });
  await sendMessage(server, owner, group, 'skipped without a mention');
  await sendMessage(server, firstPeer, reader.id, 'kept dm one');
  await sendMessage(server, secondPeer, reader.id, 'kept dm two');

  const batch = await poll(server, reader, { limit: 2 });
  const messages = batch.items.filter((item: any) => item.kind === 'message');
  const gaps = batch.items.filter((item: any) => item.kind === 'gap');

  assert.equal(messages.length, 2, 'limit:2 keeps the two newest deliveries, which are the two DMs');
  assert.deepEqual(
    messages.map((item: any) => item.to).sort(),
    [firstDm, secondDm].sort(),
    'both retained messages are the newer DM deliveries',
  );

  assert.equal(gaps.length, 1, 'only the conversation that kept no message reports a gap');
  const gap = gaps[0];
  assert.equal(gap.to, group, 'the gap names the group conversation');
  assert.equal(gap.count, 2, 'the gap counts the two skipped group messages');
  assert.equal(
    gap.before,
    3,
    'with no retained message the anchor is newestSkippedSeq + 1, not the earliest skipped seq (which is 1)',
  );
  assert.equal(gap.mentioned, 1, 'mentioned counts how many skipped messages named the reader');

  const history = await call(server, 'GET', '/v1/messages', {
    token: reader.token,
    query: { to: group, before: gap.before },
  });
  assertOk(history, 'GET /v1/messages?before=<gap.before>');
  assert.deepEqual(
    history.body.items.map((item: any) => item.seq).sort((a: number, b: number) => a - b),
    [1, 2],
    'the gap anchor reads back exactly the skipped range',
  );

  const conversations = await call(server, 'GET', '/v1/conversations', { token: reader.token });
  assertOk(conversations, 'GET /v1/conversations for the reader');
  const listed = (conversations.body.items ?? []).map((item: any) => item.to);
  assert.deepEqual([...listed].sort(), [group, firstDm, secondDm].sort(), 'the reader participates in three conversations');
});
