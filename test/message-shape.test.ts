import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertOk,
  bootstrapRoot,
  call,
  createHuman,
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

test('from_parent is true for the parent and false for a sibling or a human, and a 500 character body comes back whole', async () => {
  const owner = await spawnMember(server, root, 'shape-owner');
  const child = await spawnMember(server, owner, 'shape-child');
  const sibling = await spawnMember(server, owner, 'shape-sibling');

  const fromParent = await sendMessage(server, owner, child.id, 'a brief from your parent');
  const parentBatch = await poll(server, child);
  const parentItem = parentBatch.items.find(
    (item: any) => item.kind === 'message' && item.seq === fromParent.seq,
  );
  assert.ok(parentItem, 'the child receives the DM from its parent');
  assert.equal(parentItem.from_parent, true, 'from_parent is true when from_id is my parent_id');

  const fromSibling = await sendMessage(server, sibling, child.id, 'a note from your sibling');
  const siblingBatch = await poll(server, child);
  const siblingItem = siblingBatch.items.find(
    (item: any) => item.kind === 'message' && item.seq === fromSibling.seq,
  );
  assert.ok(siblingItem, 'the child receives the DM from its sibling');
  assert.equal(siblingItem.from_parent, false, 'a sibling is not the parent, so from_parent is false');

  const human = await createHuman(server, 'shape-human');
  const longBody = 'x'.repeat(500);
  const humanPost = await call(server, 'POST', '/v1/messages', {
    token: human.token,
    body: { to: groupConversation(owner.id), body: longBody },
  });
  assertOk(humanPost, 'POST /v1/messages as a human with a long body');

  const humanBatch = await poll(server, child);
  const humanItem = humanBatch.items.find(
    (item: any) => item.kind === 'message' && item.seq === humanPost.body.seq,
  );
  assert.ok(humanItem, 'the child receives the human message posted to its group');
  assert.equal(humanItem.from_parent, false, 'a human is nobody\'s parent, so from_parent is false');
  assert.equal(typeof humanItem.body, 'string', 'a polled message carries its body as a string');
  assert.equal(humanItem.body, longBody, 'a 500 character body is delivered whole, not truncated');
});

test('a 60000 character body sent by a member comes back from the poll byte-identical to the stored body', async () => {
  const owner = await spawnMember(server, root, 'long-body-owner');
  const child = await spawnMember(server, owner, 'long-body-child');

  // 29 ASCII code points and one CJK code point per unit: 60000 characters,
  // 64000 UTF-8 bytes, so the fixture is large but stays under the 64 KiB write limit.
  const body = 'abcdefghijklmnopqrstuvwxyz012\u4e2d'.repeat(2000);
  assert.equal(Array.from(body).length, 60000, 'the fixture is 60000 characters');
  assert.ok(new TextEncoder().encode(body).length <= 64 * 1024, 'the fixture fits the write limit');

  const sent = await sendMessage(server, owner, child.id, body);

  const history = await call(server, 'GET', '/v1/messages', {
    token: child.token,
    query: { to: dmConversation(owner.id, child.id) },
  });
  assertOk(history, 'GET /v1/messages for the long body');
  const stored = history.body.items.find((item: any) => item.seq === sent.seq);
  assert.ok(stored, 'the long message is stored in the conversation history');
  assert.equal(stored.body, body, 'the stored body is the body that was sent');

  const batch = await poll(server, child);
  const polled = batch.items.find((item: any) => item.kind === 'message' && item.seq === sent.seq);
  assert.ok(polled, 'the long message is delivered by the poll');
  assert.equal(polled.body, stored.body, 'the poll returns the stored body, not a shortened copy');
  assert.ok(
    Buffer.from(polled.body, 'utf8').equals(Buffer.from(body, 'utf8')),
    'the polled body is byte-identical to what was sent',
  );
});

test('mentions ["all"] is the @all wire form and marks every current member of the group', async () => {
  const owner = await spawnMember(server, root, 'all-owner');
  const first = await spawnMember(server, owner, 'all-first');
  const second = await spawnMember(server, owner, 'all-second');

  const posted = await sendMessage(server, owner, groupConversation(owner.id), 'everyone, look here', {
    mentions: ['all'],
  });
  assert.equal(typeof posted.seq, 'number', 'the server accepts "all" as a mentions value');

  for (const member of [first, second]) {
    const batch = await poll(server, member);
    const item = batch.items.find((candidate: any) => candidate.kind === 'message' && candidate.seq === posted.seq);
    assert.ok(item, `${member.name} receives the @all message`);
    assert.equal(item.mentions_me, true, `@all marks ${member.name} as mentioned`);
  }
});

test('resending the same client_msg_id returns the original seq and does not create a second message', async () => {
  const owner = await spawnMember(server, root, 'idem-msg-owner');
  const child = await spawnMember(server, owner, 'idem-msg-child');

  const first = await sendMessage(server, owner, child.id, 'the one and only brief', {
    client_msg_id: 'brief-1',
  });
  const second = await sendMessage(server, owner, child.id, 'the one and only brief', {
    client_msg_id: 'brief-1',
  });
  assert.equal(second.seq, first.seq, 'a resent client_msg_id returns the original conversation seq');

  const batch = await poll(server, child);
  const messages = batch.items.filter((item: any) => item.kind === 'message');
  assert.equal(messages.length, 1, 'the recipient is delivered the message only once');
  assert.equal(messages[0].seq, first.seq, 'the single delivery carries the original seq');

  const history = await call(server, 'GET', '/v1/messages', {
    token: child.token,
    query: { to: dmConversation(owner.id, child.id) },
  });
  assertOk(history, 'GET /v1/messages after a client_msg_id resend');
  assert.equal(history.body.items.length, 1, 'the resend does not create a second history record');
});
