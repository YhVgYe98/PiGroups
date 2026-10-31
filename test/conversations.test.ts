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
  type Reply,
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

function conversation(reply: Reply, to: string): any {
  assertOk(reply, 'GET /v1/conversations');
  const found = (reply.body.items ?? []).find((item: any) => item.to === to);
  assert.ok(found, `GET /v1/conversations must list the ${to} conversation — ${JSON.stringify(reply.body)}`);
  return found;
}

/**
 * The platform does not count unread: both ends keep their own position. A member polls, so its
 * cursor sits at the bottom; a human subtracts its own cursor from `last_message_seq`. The field
 * must not creep back into the payload, so the check is on the raw body, not on a parsed key.
 */
function assertNoUnread(reply: Reply, what: string): void {
  assert.ok(!reply.text.includes('unread'), `${what}: the body must carry no unread field — ${reply.text}`);
}

test('GET /v1/conversations tracks last_message_seq and last_at through deliveries and a restricting poll, and never reports unread', async () => {
  const owner = await spawnMember(server, root, 'conv-owner');
  const child = await spawnMember(server, owner, 'conv-child');
  const group = groupConversation(owner.id);
  const dm = dmConversation(owner.id, child.id);

  // Five deliveries for the child, interleaved across two conversations.
  await sendMessage(server, owner, group, 'g1');
  await sendMessage(server, owner, child.id, 'd1');
  await sendMessage(server, owner, group, 'g2');
  const newestDm = await sendMessage(server, owner, child.id, 'd2');
  const newestGroup = await sendMessage(server, owner, group, 'g3');

  const beforePoll = await call(server, 'GET', '/v1/conversations', { token: child.token });
  assertOk(beforePoll, 'GET /v1/conversations before the first poll');
  assertNoUnread(beforePoll, 'GET /v1/conversations as a member');
  const groupBefore = conversation(beforePoll, group);
  const dmBefore = conversation(beforePoll, dm);
  assert.equal(groupBefore.kind, 'group', 'a group conversation reports kind=group');
  assert.equal(groupBefore.last_message_seq, 3, 'last_message_seq is the highest seq sent in the group');
  assert.equal(groupBefore.last_at, newestGroup.created_at, 'last_at is the created_at of the newest group message');
  assert.equal(dmBefore.kind, 'dm', 'a one-to-one conversation reports kind=dm');
  assert.equal(dmBefore.last_message_seq, 2, 'last_message_seq is the highest seq sent in the DM');
  assert.equal(dmBefore.last_at, newestDm.created_at, 'last_at is the created_at of the newest DM message');
  assert.equal(dmBefore.peer, owner.id, 'a member view of a DM names the peer');
  assert.equal(
    (beforePoll.body.items ?? []).some((item: any) => item.to === groupConversation(root.id)),
    false,
    "a member's list stops at its own group and its parent's group, so the grandparent's group is absent",
  );

  // A limit:1 poll hands over one item per conversation and folds the rest into gaps; consuming
  // messages must leave the conversation listing alone.
  const batch = await poll(server, child, { limit: 1 });
  const gaps = batch.items.filter((item: any) => item.kind === 'gap');
  const groupGap = gaps.find((item: any) => item.to === group);
  const dmGap = gaps.find((item: any) => item.to === dm);
  assert.ok(groupGap, 'the limit:1 poll reports the skipped group messages as a gap');
  assert.ok(dmGap, 'the limit:1 poll reports the skipped DM messages as a gap');
  assert.equal(groupGap.count, 2, 'two group messages were folded into the gap');
  assert.equal(dmGap.count, 2, 'two DM messages were folded into the gap');

  const afterPoll = await call(server, 'GET', '/v1/conversations', { token: child.token });
  assertOk(afterPoll, 'GET /v1/conversations after the poll');
  assertNoUnread(afterPoll, 'GET /v1/conversations after a restricting poll');
  const groupAfter = conversation(afterPoll, group);
  const dmAfter = conversation(afterPoll, dm);
  assert.equal(groupAfter.last_message_seq, 3, 'consuming the group does not move last_message_seq');
  assert.equal(groupAfter.last_at, newestGroup.created_at, 'consuming the group does not move last_at');
  assert.equal(dmAfter.last_message_seq, 2, 'consuming the DM does not move last_message_seq');
  assert.equal(dmAfter.last_at, newestDm.created_at, 'consuming the DM does not move last_at');

  await sendMessage(server, owner, group, 'g4');
  const newestAgain = await sendMessage(server, owner, group, 'g5');
  const afterDeliveries = await call(server, 'GET', '/v1/conversations', { token: child.token });
  assertOk(afterDeliveries, 'GET /v1/conversations after two fresh deliveries');
  assertNoUnread(afterDeliveries, 'GET /v1/conversations after two fresh deliveries');
  const groupAgain = conversation(afterDeliveries, group);
  assert.equal(groupAgain.last_message_seq, 5, 'last_message_seq follows the highest seq sent');
  assert.equal(groupAgain.last_at, newestAgain.created_at, 'last_at follows the newest message');

  const human = await createHuman(server, 'conv-human');
  const humanView = await call(server, 'GET', '/v1/conversations', { token: human.token });
  assertOk(humanView, 'GET /v1/conversations as a human');
  assertNoUnread(humanView, 'GET /v1/conversations as a human');
  const humanGroup = conversation(humanView, group);
  const humanDm = conversation(humanView, dm);
  assert.equal(humanGroup.last_message_seq, 5, 'a human sees the group last_message_seq');
  assert.equal(humanGroup.last_at, newestAgain.created_at, 'a human sees the group last_at');
  assert.equal(humanDm.last_message_seq, 2, 'a human sees the DM last_message_seq');
  assert.equal(humanDm.last_at, newestDm.created_at, 'a human sees the DM last_at');
  assert.equal(humanDm.peer, undefined, 'a human view of a DM has no peer');

  // A human's list covers every conversation, including the root's group, which the child above
  // does not see and nothing has been sent to yet.
  const emptyRootGroup = conversation(humanView, groupConversation(root.id));
  assert.equal(emptyRootGroup.kind, 'group', "the root's group is listed for a human");
  assert.equal(emptyRootGroup.last_message_seq, 0, 'an empty group has last_message_seq 0');
  assert.equal(emptyRootGroup.last_at, null, 'an empty group has last_at null');
});
