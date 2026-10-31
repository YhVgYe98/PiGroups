import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  bootstrapRoot,
  call,
  dmConversation,
  groupConversation,
  poll,
  sendControl,
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

test('a poll delivers the newest limit messages and reports the older skipped ones as gap items with count and before', async () => {
  const owner = await spawnMember(server, root, 'gap-owner');
  const child = await spawnMember(server, owner, 'gap-child');
  const group = groupConversation(owner.id);
  const dm = dmConversation(owner.id, child.id);

  // Five deliveries for the child: group seq 1..3 and DM seq 1..2, interleaved.
  await sendMessage(server, owner, group, 'g1');
  await sendMessage(server, owner, child.id, 'd1');
  await sendMessage(server, owner, group, 'g2');
  await sendMessage(server, owner, child.id, 'd2');
  await sendMessage(server, owner, group, 'g3');

  const batch = await poll(server, child, { limit: 2 });
  const messages = batch.items.filter((item: any) => item.kind === 'message');
  const gaps = batch.items.filter((item: any) => item.kind === 'gap');

  assert.equal(messages.length, 2, 'limit caps how many messages one poll delivers');
  const groupMessage = messages.find((item: any) => item.to === group);
  const dmMessage = messages.find((item: any) => item.to === dm);
  assert.ok(groupMessage, 'the newest group message is delivered');
  assert.ok(dmMessage, 'the newest DM message is delivered');
  assert.equal(groupMessage.seq, 3, 'the newest message of the group conversation is the one kept');
  assert.equal(dmMessage.seq, 2, 'the newest message of the DM conversation is the one kept');

  assert.equal(gaps.length, 2, 'every conversation with skipped messages reports one gap');
  const groupGap = gaps.find((item: any) => item.to === group);
  const dmGap = gaps.find((item: any) => item.to === dm);
  assert.ok(groupGap, 'the group conversation reports its skipped messages');
  assert.ok(dmGap, 'the DM conversation reports its skipped messages');
  assert.equal(groupGap.count, 2, 'the group gap counts the two skipped messages');
  assert.equal(groupGap.before, 3, 'the group gap anchors on the earliest retained seq');
  assert.equal(dmGap.count, 1, 'the DM gap counts the one skipped message');
  assert.equal(dmGap.before, 2, 'the DM gap anchors on the earliest retained seq');
  assert.equal(batch.control_pending, 0, 'nothing is left pending on the control channel');

  const quiet = await poll(server, child, { limit: 2 });
  assert.deepEqual(quiet.items, [], 'the skipped messages are not handed out again by a later poll');
});

test('the item order is control, then gap, then message', async () => {
  const owner = await spawnMember(server, root, 'order-owner');
  const child = await spawnMember(server, owner, 'order-child');

  await sendControl(server, owner, child.id, 'order-1', 'pi.ping');
  await sendMessage(server, owner, groupConversation(owner.id), 'o1');
  await sendMessage(server, owner, groupConversation(owner.id), 'o2');
  await sendMessage(server, owner, groupConversation(owner.id), 'o3');

  const batch = await poll(server, child, { limit: 1 });
  assert.deepEqual(
    batch.items.map((item: any) => item.kind),
    ['control', 'gap', 'message'],
    'one batch is ordered control, then gap, then message',
  );
  assert.equal(batch.items[0].cmd, 'pi.ping', 'the control item carries the command');
  assert.equal(batch.items[0].from_id, owner.id, 'the control item carries its sender');
  assert.equal(batch.items[1].to, groupConversation(owner.id), 'the gap names its conversation');
  assert.equal(batch.items[1].count, 2, 'the gap counts what it skipped');
  assert.equal(batch.items[1].before, 3, 'the gap anchors on the earliest retained seq');
  assert.equal(batch.items[2].seq, 3, 'the message item is the newest retained message');
});

test('types=message neither consumes nor marks delivered a pending instruction', async () => {
  const owner = await spawnMember(server, root, 'types-owner');
  const child = await spawnMember(server, owner, 'types-child');
  const sent = await sendControl(server, owner, child.id, 'types-1', 'pi.hold');

  const messagesOnly = await poll(server, child, { types: 'message' });
  assert.equal(
    messagesOnly.items.some((item: any) => item.kind === 'control'),
    false,
    'types=message excludes control items',
  );
  assert.equal(messagesOnly.control_pending, 1, 'the excluded instruction is still pending after the poll');

  const pending = await call(server, 'GET', '/v1/control', { token: owner.token, query: { since: 0 } });
  const pendingRecord = pending.body.items.find((item: any) => item.id === 'types-1');
  assert.ok(pendingRecord, 'the sender can look up the instruction it sent');
  assert.equal(pendingRecord.seq, sent.control_seq, 'the record reports the control_seq from the send');
  assert.equal(
    pendingRecord.receipts[0].state,
    'pending',
    'a types=message poll does not mark the instruction delivered',
  );

  const controlsOnly = await poll(server, child, { types: 'control' });
  const control = controlsOnly.items.find((item: any) => item.kind === 'control');
  assert.ok(control, 'the instruction is still there for a control-only poll');
  assert.equal(control.cmd, 'pi.hold', 'the instruction was not consumed by the message-only poll');

  const after = await call(server, 'GET', '/v1/control', { token: owner.token, query: { since: 0 } });
  const delivered = after.body.items.find((item: any) => item.id === 'types-1');
  assert.equal(delivered.receipts[0].state, 'delivered', 'taking the instruction out of a poll marks it delivered');
});

test('a long poll returns an empty list after wait elapses', async () => {
  const owner = await spawnMember(server, root, 'wait-owner');
  const child = await spawnMember(server, owner, 'wait-child');

  const startedAt = Date.now();
  const batch = await poll(server, child, { wait: 1 }, 10_000);
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(batch.items, [], 'a long poll with nothing to deliver returns an empty list');
  assert.equal(batch.control_pending, 0, 'nothing is pending for this member');
  assert.ok(elapsedMs >= 900, `the poll returned after ${elapsedMs}ms; it should have waited about 1s`);
  assert.ok(elapsedMs < 10_000, `the poll returned after ${elapsedMs}ms; it should not outlast its wait`);
});
