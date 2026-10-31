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

function conversation(reply: { body: any }, to: string): any {
  assertOk(reply, 'GET /v1/conversations');
  const found = (reply.body.items ?? []).find((item: any) => item.to === to);
  assert.ok(found, `GET /v1/conversations must list the ${to} conversation — ${JSON.stringify(reply.body)}`);
  return found;
}

test('GET /v1/conversations reports the consume cursor as unread, counts gap-folded messages as consumed, and returns null unread for a human', async () => {
  const owner = await spawnMember(server, root, 'conv-owner');
  const child = await spawnMember(server, owner, 'conv-child');
  const group = groupConversation(owner.id);
  const dm = dmConversation(owner.id, child.id);

  // Five deliveries for the child, interleaved across two conversations.
  await sendMessage(server, owner, group, 'g1');
  await sendMessage(server, owner, child.id, 'd1');
  await sendMessage(server, owner, group, 'g2');
  await sendMessage(server, owner, child.id, 'd2');
  await sendMessage(server, owner, group, 'g3');

  const unreadBeforePoll = await call(server, 'GET', '/v1/conversations', { token: child.token });
  assertOk(unreadBeforePoll, 'GET /v1/conversations before the first poll');
  const groupBefore = conversation(unreadBeforePoll, group);
  const dmBefore = conversation(unreadBeforePoll, dm);
  assert.equal(groupBefore.kind, 'group', 'a group conversation reports kind=group');
  assert.equal(groupBefore.unread, 3, 'unread counts every group delivery the member has not consumed');
  assert.equal(groupBefore.last_message_seq, 3, 'last_message_seq is the highest seq sent in the group');
  assert.equal(dmBefore.kind, 'dm', 'a one-to-one conversation reports kind=dm');
  assert.equal(dmBefore.unread, 2, 'unread counts every DM delivery the member has not consumed');
  assert.equal(dmBefore.last_message_seq, 2, 'last_message_seq is the highest seq sent in the DM');
  assert.equal(dmBefore.peer, owner.id, 'a member view of a DM names the peer');

  const batch = await poll(server, child, { limit: 1 });
  const gaps = batch.items.filter((item: any) => item.kind === 'gap');
  const groupGap = gaps.find((item: any) => item.to === group);
  const dmGap = gaps.find((item: any) => item.to === dm);
  assert.ok(groupGap, 'the limit:1 poll reports the skipped group messages as a gap');
  assert.ok(dmGap, 'the limit:1 poll reports the skipped DM messages as a gap');
  assert.equal(groupGap.count, 2, 'two group messages were folded into the gap');
  assert.equal(dmGap.count, 1, 'one DM message was folded into the gap');

  const unreadAfterPoll = await call(server, 'GET', '/v1/conversations', { token: child.token });
  assertOk(unreadAfterPoll, 'GET /v1/conversations after the poll');
  const groupAfter = conversation(unreadAfterPoll, group);
  const dmAfter = conversation(unreadAfterPoll, dm);
  assert.equal(
    groupAfter.unread,
    0,
    'messages folded into a gap count as consumed, so the group has no unread left',
  );
  assert.equal(dmAfter.unread, 0, 'messages folded into a gap count as consumed in a DM too');
  assert.equal(groupAfter.last_message_seq, 3, 'last_message_seq still reports the highest seq sent');
  assert.equal(dmAfter.last_message_seq, 2, 'the DM last_message_seq is unchanged by consumption');

  await sendMessage(server, owner, group, 'g4');
  await sendMessage(server, owner, group, 'g5');
  const unreadAgain = await call(server, 'GET', '/v1/conversations', { token: child.token });
  assertOk(unreadAgain, 'GET /v1/conversations after two fresh deliveries');
  const groupAgain = conversation(unreadAgain, group);
  assert.equal(groupAgain.unread, 2, 'unread counts the deliveries that arrived after the consume cursor');
  assert.equal(groupAgain.last_message_seq, 5, 'last_message_seq follows the highest seq sent');

  const human = await createHuman(server, 'conv-human');
  const humanView = await call(server, 'GET', '/v1/conversations', { token: human.token });
  assertOk(humanView, 'GET /v1/conversations as a human');
  const humanGroup = conversation(humanView, group);
  const humanDm = conversation(humanView, dm);
  assert.equal(humanGroup.unread, null, 'a human has no server-side read position, so group unread is null');
  assert.equal(humanDm.unread, null, 'a human has no server-side read position, so DM unread is null');
  assert.equal(humanGroup.last_message_seq, 5, 'a human sees the group last_message_seq');
});
