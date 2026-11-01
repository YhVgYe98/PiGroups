import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertErrorCode,
  assertOk,
  assertStatus,
  bootstrapRoot,
  call,
  createHuman,
  sendControl,
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

/** The all-view of GET /v1/control; only a human token may ask for it. */
function readAll(
  target: Server,
  principal: Principal,
  query: Record<string, string | number | undefined> = {},
) {
  return call(target, 'GET', '/v1/control', {
    token: principal.token,
    query: { all: 'true', ...query },
  });
}

test('a human reads another pair\'s instruction with its from_id, to, cmd and payload', async () => {
  const owner = await spawnMember(server, root, 'all-read-owner');
  const sender = await spawnMember(server, owner, 'all-read-sender');
  const receiver = await spawnMember(server, owner, 'all-read-receiver');
  const human = await createHuman(server, 'all-read-human');

  const sent = await sendControl(server, sender, receiver.id, 'all-read-1', 'pi.abort-because-stalled', {
    payload: { reason: 'stalled 12m', ticket: 'T-4711' },
  });

  const all = await readAll(server, human, { since: 0 });
  assertStatus(all, 200, 'GET /v1/control?all=true as a human');

  const record = all.body.items.find((item: any) => item.id === 'all-read-1');
  assert.ok(record, 'a human sees an instruction exchanged between two members');
  assert.equal(record.seq, sent.control_seq, 'the record reports the instruction control_seq');
  assert.equal(record.from_id, sender.id, 'the record names the member that sent the instruction');
  assert.equal(record.to, receiver.id, 'the record names the target of the instruction');
  assert.equal(record.cmd, 'pi.abort-because-stalled', 'a human reads the command text itself');
  assert.deepEqual(
    record.payload,
    { reason: 'stalled 12m', ticket: 'T-4711' },
    'a human reads the payload, still opaque and untouched',
  );
  assert.equal(
    all.text.includes('pi.abort-because-stalled'),
    true,
    'the human view carries the command text, not just the receipt state',
  );
});

test('a member may not use all=true, and its plain listing still returns only its own sends', async () => {
  const owner = await spawnMember(server, root, 'all-gate-owner');
  const member = await spawnMember(server, owner, 'all-gate-member');
  const peer = await spawnMember(server, owner, 'all-gate-peer');

  await sendControl(server, member, peer.id, 'all-gate-mine', 'pi.mine');
  await sendControl(server, peer, member.id, 'all-gate-theirs', 'pi.theirs');

  const denied = await readAll(server, member, { since: 0 });
  assertStatus(denied, 403, 'GET /v1/control?all=true as a member');
  assertErrorCode(denied, 'forbidden', 'GET /v1/control?all=true as a member');
  assert.equal(
    denied.text.includes('pi.theirs'),
    false,
    'the refused all-view does not leak the other member\'s command text',
  );

  const plain = await call(server, 'GET', '/v1/control', { token: member.token, query: { since: 0 } });
  assertOk(plain, 'GET /v1/control without all as a member');
  const ids = plain.body.items.map((item: any) => item.id);
  assert.equal(ids.includes('all-gate-mine'), true, 'a member still reads the instructions it sent');
  assert.equal(ids.includes('all-gate-theirs'), false, 'a member never reads an instruction sent to it');
});

test('the human all-view pages on control_seq, and since=next continues with no repeats', async () => {
  const own = await startServer();
  try {
    const localRoot = await bootstrapRoot(own, 'page-root');
    const first = await spawnMember(own, localRoot, 'page-first');
    const second = await spawnMember(own, localRoot, 'page-second');
    const third = await spawnMember(own, localRoot, 'page-third');
    const fourth = await spawnMember(own, localRoot, 'page-fourth');
    const human = await createHuman(own, 'page-human');

    await sendControl(own, first, second.id, 'page-1', 'pi.page-1');
    await sendControl(own, first, second.id, 'page-2', 'pi.page-2');
    await sendControl(own, first, second.id, 'page-3', 'pi.page-3');
    await sendControl(own, third, fourth.id, 'page-4', 'pi.page-4');
    await sendControl(own, fourth, third.id, 'page-5', 'pi.page-5');

    const page1 = await readAll(own, human, { since: 0, limit: 2 });
    assertStatus(page1, 200, 'GET /v1/control?all=true&limit=2');
    assert.equal(page1.body.items.length, 2, 'limit caps the human all-view');
    const [firstItem, secondItem] = page1.body.items;
    assert.ok(firstItem.seq < secondItem.seq, 'the human all-view is ordered by ascending control_seq');
    assert.equal(page1.body.next, secondItem.seq, 'next is the highest control_seq served');

    const page2 = await readAll(own, human, { since: page1.body.next, limit: 2 });
    assertStatus(page2, 200, 'GET /v1/control?all=true&since=next&limit=2');
    assert.equal(page2.body.items.length, 2, 'the next page is full while instructions remain');
    assert.ok(
      page2.body.items[0].seq > page1.body.next,
      'since is an exclusive cursor, so the next page starts after it',
    );
    assert.ok(
      page2.body.items[0].seq < page2.body.items[1].seq,
      'the next page is ascending as well',
    );
    assert.equal(page2.body.next, page2.body.items[1].seq, 'next advances to the newest seq of this page');
    const servedOnPage1 = page1.body.items.map((item: any) => item.id);
    assert.deepEqual(
      page2.body.items.filter((item: any) => servedOnPage1.includes(item.id)),
      [],
      'following next never repeats an instruction',
    );

    const page3 = await readAll(own, human, { since: page2.body.next, limit: 2 });
    assertStatus(page3, 200, 'GET /v1/control?all=true after the second page');
    assert.deepEqual(
      [...servedOnPage1, ...page2.body.items.map((item: any) => item.id), ...page3.body.items.map((item: any) => item.id)],
      ['page-1', 'page-2', 'page-3', 'page-4', 'page-5'],
      'paging through the human all-view visits every instruction exactly once, in send order',
    );
    assert.equal(page3.body.next, null, 'next is null once nothing is left');
  } finally {
    await own.stop();
  }
});

test('the sender\'s own view still hides cmd and payload, and the receiver\'s view does not show it at all', async () => {
  const owner = await spawnMember(server, root, 'hide-owner');
  const sender = await spawnMember(server, owner, 'hide-sender');
  const receiver = await spawnMember(server, owner, 'hide-receiver');

  const cmd = 'pi.pause-because-of-stall-9f3a';
  const payload = { reason: 'stalled-12m-9f3a', ticket: 'T-9f3a' };
  await sendControl(server, sender, receiver.id, 'hide-1', cmd, { payload });

  const senderView = await call(server, 'GET', '/v1/control', { token: sender.token, query: { since: 0 } });
  assertOk(senderView, 'GET /v1/control as the sender');
  const senderRecord = senderView.body.items.find((item: any) => item.id === 'hide-1');
  assert.ok(senderRecord, 'the sender still sees the instruction it sent');
  assert.equal(senderRecord.receipts[0].to_id, receiver.id, 'the sender sees the receipt state only');
  assert.equal('cmd' in senderRecord, false, 'the sender record carries no cmd field');
  assert.equal('payload' in senderRecord, false, 'the sender record carries no payload field');
  assert.equal(senderView.text.includes(cmd), false, 'the command text appears nowhere in the sender\'s raw response');
  assert.equal(senderView.text.includes('stalled-12m-9f3a'), false, 'the payload appears nowhere in the sender\'s raw response');

  const receiverView = await call(server, 'GET', '/v1/control', {
    token: receiver.token,
    query: { since: 0 },
  });
  assertOk(receiverView, 'GET /v1/control as the receiver without all');
  assert.equal(
    receiverView.body.items.some((item: any) => item.id === 'hide-1'),
    false,
    'an instruction the member received does not appear in its own listing at all',
  );
  assert.equal(receiverView.text.includes(cmd), false, 'the command text appears nowhere in the receiver\'s raw response');
  assert.equal(
    receiverView.text.includes('stalled-12m-9f3a'),
    false,
    'the payload appears nowhere in the receiver\'s raw response',
  );
});

test('a human still reads the whole control log after a member was deleted', async () => {
  const owner = await spawnMember(server, root, 'after-delete-owner');
  const doomed = await spawnMember(server, owner, 'after-delete-child');
  const human = await createHuman(server, 'after-delete-human');

  // The delete writes a `sys.terminated` notice per node. That row goes through the
  // same table as every other instruction, so a malformed `to` there does not fail the
  // delete — it fails the human's audit, which is the record of the delete itself.
  const removed = await call(server, 'DELETE', `/v1/members/${doomed.id}`, { token: owner.token });
  assertStatus(removed, 200, 'DELETE /v1/members/{id}');

  const all = await readAll(server, human, { since: 0 });
  assertStatus(all, 200, 'GET /v1/control?all=true after a delete');

  const notice = all.body.items.find(
    (item: any) => item.cmd === 'sys.terminated' && item.to === doomed.id,
  );
  assert.ok(notice, 'the termination notice is readable, with the target as a plain id');
  assert.equal(notice.from_id, 'sys', 'the platform itself is the sender of the notice');
  assert.deepEqual(notice.payload, { reason: 'deleted', terminated_by: owner.id });
});
