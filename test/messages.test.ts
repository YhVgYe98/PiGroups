import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertErrorCode,
  assertStatus,
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

test('a member can DM any member, a human cannot DM, and a self-DM is 400', async () => {
  const a = await spawnMember(server, root, 'dm-a');
  const b = await spawnMember(server, root, 'dm-b');

  const toSibling = await sendMessage(server, a, b.id, 'sibling ping');
  assert.equal(toSibling.to, dmConversation(a.id, b.id), 'a DM is addressed as dm:<min>_<max>');
  assert.deepEqual(toSibling.recipients, [b.id], 'the peer is the only recipient');

  const toParent = await sendMessage(server, a, root.id, 'reporting in');
  assert.equal(toParent.to, dmConversation(a.id, root.id), 'a child can DM its parent');

  const toChild = await sendMessage(server, root, a.id, 'task brief');
  assert.equal(toChild.to, dmConversation(root.id, a.id), 'a parent can DM its child');

  const back = await sendMessage(server, b, a.id, 'pong');
  assert.equal(back.to, toSibling.to, 'both directions address the same DM conversation');
  assert.equal(back.seq, toSibling.seq + 1, 'the DM conversation keeps one counter');

  const human = await createHuman(server, 'human-dm');
  const humanDm = await call(server, 'POST', '/v1/messages', {
    token: human.token,
    body: { to: a.id, body: 'a human may not open a DM' },
  });
  assertStatus(humanDm, 403, 'a human posting a DM');
  assertErrorCode(humanDm, 'forbidden', 'a human posting a DM');

  const self = await call(server, 'POST', '/v1/messages', {
    token: a.token,
    body: { to: a.id, body: 'note to self' },
  });
  assertStatus(self, 400, 'a member DMing itself');
  assertErrorCode(self, 'bad_request', 'a member DMing itself');
});

test('posting to a group delivers to the children but not to the sender, and a group with no live child is 404', async () => {
  const owner = await spawnMember(server, root, 'group-owner');
  const first = await spawnMember(server, owner, 'group-first');
  const second = await spawnMember(server, owner, 'group-second');

  const posted = await sendMessage(server, owner, groupConversation(owner.id), 'standup');
  assert.deepEqual(
    [...posted.recipients].sort(),
    [first.id, second.id].sort(),
    'the group fans out to the direct children',
  );
  assert.equal(posted.recipients.includes(owner.id), false, 'the sender does not receive its own message');

  const firstBatch = await poll(server, first);
  const firstMessages = firstBatch.items.filter((item: any) => item.kind === 'message');
  assert.equal(firstMessages.length, 1, 'the first child receives the group message');
  assert.equal(firstMessages[0].to, groupConversation(owner.id), 'the delivered message names its group');
  assert.equal(firstMessages[0].seq, posted.seq, 'the delivered message keeps its conversation seq');
  assert.equal(firstMessages[0].from_id, owner.id, 'the delivered message carries the sender');

  const secondBatch = await poll(server, second);
  const secondMessages = secondBatch.items.filter((item: any) => item.kind === 'message');
  assert.equal(secondMessages.length, 1, 'the second child receives the group message too');

  const ownerBatch = await poll(server, owner);
  assert.equal(
    ownerBatch.items.some(
      (item: any) => item.kind === 'message' && item.to === groupConversation(owner.id) && item.seq === posted.seq,
    ),
    false,
    'the sender is not delivered to in its own group',
  );

  const leaf = await spawnMember(server, owner, 'group-leaf');
  const emptyGroup = await call(server, 'POST', '/v1/messages', {
    token: leaf.token,
    body: { to: groupConversation(leaf.id), body: 'anyone in my group?' },
  });
  assertStatus(emptyGroup, 404, 'posting to the group of a member that has no live child');
  assertErrorCode(emptyGroup, 'no_such_group', 'posting to the group of a member that has no live child');
});

test('mentions marks only the listed members, a mention outside the group is 400, and a DM carrying mentions is 400', async () => {
  const owner = await spawnMember(server, root, 'mention-owner');
  const target = await spawnMember(server, owner, 'mention-target');
  const other = await spawnMember(server, owner, 'mention-other');
  const outsider = await spawnMember(server, target, 'mention-outsider');

  const marked = await sendMessage(server, owner, groupConversation(owner.id), 'target, please look', {
    mentions: [target.id],
  });

  const targetBatch = await poll(server, target);
  const targetItem = targetBatch.items.find(
    (item: any) => item.kind === 'message' && item.seq === marked.seq,
  );
  assert.ok(targetItem, 'the mentioned member receives the message');
  assert.equal(targetItem.mentions_me, true, 'the listed member is marked as mentioned');

  const otherBatch = await poll(server, other);
  const otherItem = otherBatch.items.find((item: any) => item.kind === 'message' && item.seq === marked.seq);
  assert.ok(otherItem, 'the unmentioned group member still receives the message');
  assert.equal(otherItem.mentions_me, false, 'an unlisted member is not marked');

  const plain = await sendMessage(server, owner, groupConversation(owner.id), 'no one in particular');
  const targetPlainBatch = await poll(server, target);
  const plainItem = targetPlainBatch.items.find(
    (item: any) => item.kind === 'message' && item.seq === plain.seq,
  );
  assert.ok(plainItem, 'the message with no mentions is delivered');
  assert.equal(plainItem.mentions_me, false, 'a message without mentions marks nobody');

  const outside = await call(server, 'POST', '/v1/messages', {
    token: owner.token,
    body: { to: groupConversation(owner.id), body: 'hey outsider', mentions: [outsider.id] },
  });
  assertStatus(outside, 400, 'mentioning a member who is not in the group');
  assertErrorCode(outside, 'unknown_mention', 'mentioning a member who is not in the group');

  const dmWithMentions = await call(server, 'POST', '/v1/messages', {
    token: target.token,
    body: { to: other.id, body: 'a DM with an @', mentions: [other.id] },
  });
  assertStatus(dmWithMentions, 400, 'a DM carrying mentions');
  assert.equal(typeof dmWithMentions.body?.error?.code, 'string', 'the rejected DM carries an error code');
});

test('per-conversation numbering starts at seq 1 in two different conversations', async () => {
  const owner = await spawnMember(server, root, 'seq-owner');
  const first = await spawnMember(server, owner, 'seq-first');
  const second = await spawnMember(server, owner, 'seq-second');

  const dm = await sendMessage(server, first, second.id, 'dm one');
  const group = await sendMessage(server, first, groupConversation(owner.id), 'group one');
  assert.equal(dm.seq, 1, 'a fresh DM conversation starts at seq 1');
  assert.equal(group.seq, 1, 'a fresh group conversation also starts at seq 1');

  const groupAgain = await sendMessage(server, second, groupConversation(owner.id), 'group two');
  assert.equal(groupAgain.seq, 2, 'the group conversation keeps its own counter');

  const dmBack = await sendMessage(server, second, first.id, 'dm two');
  assert.equal(dmBack.seq, 2, 'the DM conversation keeps its own counter');

  const freshDm = await sendMessage(server, first, owner.id, 'dm to the owner');
  assert.equal(freshDm.seq, 1, 'a third conversation starts at seq 1 again');
});
