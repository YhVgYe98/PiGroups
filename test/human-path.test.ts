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

test('a human can post to a group and its members see from_kind human with from_parent false', async () => {
  const owner = await spawnMember(server, root, 'human-path-owner');
  const child = await spawnMember(server, owner, 'human-path-child');
  const human = await createHuman(server, 'human-path-human');

  const posted = await call(server, 'POST', '/v1/messages', {
    token: human.token,
    body: { to: groupConversation(owner.id), body: 'a human joins the group' },
  });
  assertOk(posted, 'POST /v1/messages as a human');
  assert.equal(posted.body.to, groupConversation(owner.id), 'a human post lands in the named group');
  assert.deepEqual(
    [...posted.body.recipients].sort(),
    [owner.id, child.id].sort(),
    'a human post is delivered to every member of the group',
  );

  const childBatch = await poll(server, child);
  const message = childBatch.items.find(
    (item: any) => item.kind === 'message' && item.seq === posted.body.seq,
  );
  assert.ok(message, 'a member receives the message a human posted to its group');
  assert.equal(message.from_kind, 'human', 'the delivered message marks that a human said it');
  assert.equal(message.from_id, human.id, 'the delivered message carries the human id');
  assert.equal(message.from_parent, false, 'a human is nobody\'s parent, so from_parent is false');
});

test('a human can read a DM by its conversation id', async () => {
  const owner = await spawnMember(server, root, 'human-read-owner');
  const peer = await spawnMember(server, root, 'human-read-peer');
  const human = await createHuman(server, 'human-read-human');

  const dm = await sendMessage(server, owner, peer.id, 'a private exchange');
  assert.equal(dm.to, dmConversation(owner.id, peer.id), 'the DM conversation id is dm:<a>_<b>');

  const read = await call(server, 'GET', '/v1/messages', {
    token: human.token,
    query: { to: dm.to },
  });
  assertOk(read, 'GET /v1/messages as a human on a DM it does not belong to');
  assert.deepEqual(
    read.body.items.map((item: any) => item.seq),
    [dm.seq],
    'a human can read the history of any conversation',
  );
  assert.equal(read.body.items[0].sender_kind, 'member', 'the history keeps the sender kind of each message');
});
