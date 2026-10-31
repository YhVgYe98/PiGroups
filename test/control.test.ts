import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertErrorCode,
  assertOk,
  assertStatus,
  bootstrapRoot,
  call,
  groupConversation,
  poll,
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

test('an instruction goes from pending to delivered, and GET /v1/control never returns cmd', async () => {
  const owner = await spawnMember(server, root, 'ctl-owner');
  const child = await spawnMember(server, owner, 'ctl-child');

  const sent = await call(server, 'POST', '/v1/control', {
    token: owner.token,
    body: { to: child.id, id: 'ctl-1', cmd: 'pi.pause', payload: { note: 'because' } },
  });
  assertOk(sent, 'POST /v1/control');
  assert.equal(typeof sent.body.control_seq, 'number', 'POST /v1/control returns a control_seq');
  assert.equal(sent.body.receipts.length, 1, 'one target yields one receipt');
  assert.equal(sent.body.receipts[0].to_id, child.id, 'the receipt names the target');
  assert.equal(sent.body.receipts[0].state, 'pending', 'a fresh instruction starts out pending');

  const pending = await call(server, 'GET', '/v1/control', { token: owner.token, query: { since: 0 } });
  assertOk(pending, 'GET /v1/control');
  const pendingRecord = pending.body.items.find((item: any) => item.id === 'ctl-1');
  assert.ok(pendingRecord, 'the sender sees the instruction it sent');
  assert.equal(pendingRecord.seq, sent.body.control_seq, 'the record reports the control_seq');
  assert.equal(pendingRecord.receipts[0].state, 'pending', 'the target has not taken it yet');
  assert.equal(pendingRecord.receipts[0].delivered_at, null, 'a pending receipt has no delivery time');
  assert.equal('cmd' in pendingRecord, false, 'GET /v1/control does not return cmd');
  assert.equal('payload' in pendingRecord, false, 'GET /v1/control does not return payload');
  assert.equal(pending.text.includes('pi.pause'), false, 'the command text never appears in the status response');
  assert.equal(pending.text.includes('because'), false, 'the payload never appears in the status response');

  const batch = await poll(server, child);
  const control = batch.items.find((item: any) => item.kind === 'control');
  assert.ok(control, 'the target receives the instruction on its poll');
  assert.equal(control.cmd, 'pi.pause', 'the instruction reaches the target with its command text');
  assert.equal(control.from_id, owner.id, 'the instruction carries its sender');
  assert.deepEqual(control.payload, { note: 'because' }, 'the instruction payload is passed through untouched');

  const delivered = await call(server, 'GET', '/v1/control', { token: owner.token, query: { since: 0 } });
  assertOk(delivered, 'GET /v1/control after delivery');
  const deliveredRecord = delivered.body.items.find((item: any) => item.id === 'ctl-1');
  assert.ok(deliveredRecord, 'the sender still sees the instruction');
  assert.equal(deliveredRecord.receipts[0].state, 'delivered', 'taking the instruction out of a poll marks it delivered');
  assert.equal(typeof deliveredRecord.receipts[0].delivered_at, 'number', 'a delivered receipt carries a timestamp');
  assert.equal(delivered.text.includes('pi.pause'), false, 'the status response still never contains cmd');
  assert.equal(delivered.text.includes('because'), false, 'the status response still never contains payload');
});

test('POST /v1/control separates a cross-group target, a never-existing id, a gone target, and an over-long cmd', async () => {
  const owner = await spawnMember(server, root, 'reach-owner');
  const sibling = await spawnMember(server, root, 'reach-sibling');
  const child = await spawnMember(server, owner, 'reach-child');
  const outsider = await spawnMember(server, sibling, 'reach-outsider');

  const crossGroup = await call(server, 'POST', '/v1/control', {
    token: child.token,
    body: { to: outsider.id, id: 'reach-cross', cmd: 'pi.ping' },
  });
  assertStatus(crossGroup, 403, 'an instruction to a member outside my group');
  assertErrorCode(crossGroup, 'forbidden', 'an instruction to a member outside my group');

  const neverExisted = await call(server, 'POST', '/v1/control', {
    token: owner.token,
    body: { to: 'm_000000', id: 'reach-unknown', cmd: 'pi.ping' },
  });
  assertStatus(neverExisted, 404, 'an instruction to a member id that never existed');
  assertErrorCode(neverExisted, 'not_found', 'an instruction to a member id that never existed');

  const doomed = await spawnMember(server, owner, 'reach-doomed');
  const deleted = await call(server, 'DELETE', `/v1/members/${doomed.id}`, { token: owner.token });
  assertStatus(deleted, 200, `DELETE /v1/members/${doomed.id}`);
  const goneTarget = await call(server, 'POST', '/v1/control', {
    token: owner.token,
    body: { to: doomed.id, id: 'reach-gone', cmd: 'pi.ping' },
  });
  assertStatus(goneTarget, 410, 'an instruction to a gone member');
  assertErrorCode(goneTarget, 'member_gone', 'an instruction to a gone member');

  const longCmd = await call(server, 'POST', '/v1/control', {
    token: owner.token,
    body: { to: child.id, id: 'reach-long', cmd: 'x'.repeat(201) },
  });
  assertStatus(longCmd, 400, 'an instruction whose cmd is 201 characters');
  assertErrorCode(longCmd, 'invalid_cmd', 'an instruction whose cmd is 201 characters');
});

test('POST /v1/control with an array of targets reaches exactly those members and not the sender', async () => {
  const owner = await spawnMember(server, root, 'array-owner');
  const first = await spawnMember(server, owner, 'array-first');
  const second = await spawnMember(server, owner, 'array-second');

  const sent = await sendControl(server, owner, [first.id, second.id], 'array-1', 'pi.sync');
  assert.deepEqual(
    sent.receipts.map((receipt: any) => receipt.to_id).sort(),
    [first.id, second.id].sort(),
    'an array of targets yields one receipt per listed member',
  );

  const firstBatch = await poll(server, first);
  const firstControl = firstBatch.items.find((item: any) => item.kind === 'control' && item.cmd === 'pi.sync');
  assert.ok(firstControl, 'the first listed member receives the instruction');
  assert.equal(firstControl.from_id, owner.id, 'the instruction carries the sender');

  const secondBatch = await poll(server, second);
  const secondControl = secondBatch.items.find((item: any) => item.kind === 'control' && item.cmd === 'pi.sync');
  assert.ok(secondControl, 'the second listed member receives the instruction');

  const senderBatch = await poll(server, owner);
  assert.equal(
    senderBatch.items.some((item: any) => item.kind === 'control' && item.cmd === 'pi.sync'),
    false,
    'the sender is never one of its own targets',
  );
});

test('POST /v1/control to g:<owner> reaches every member of that group except the sender', async () => {
  const owner = await spawnMember(server, root, 'fanout-owner');
  const sender = await spawnMember(server, owner, 'fanout-sender');
  const peer = await spawnMember(server, owner, 'fanout-peer');

  const sent = await sendControl(server, sender, groupConversation(owner.id), 'fanout-1', 'pi.broadcast');
  assert.deepEqual(
    sent.receipts.map((receipt: any) => receipt.to_id).sort(),
    [owner.id, peer.id].sort(),
    'the group target expands to the owner and the siblings, minus the sender',
  );

  const ownerBatch = await poll(server, owner);
  assert.ok(
    ownerBatch.items.some((item: any) => item.kind === 'control' && item.cmd === 'pi.broadcast'),
    'the group owner receives an instruction addressed to the group',
  );
  const peerBatch = await poll(server, peer);
  assert.ok(
    peerBatch.items.some((item: any) => item.kind === 'control' && item.cmd === 'pi.broadcast'),
    'a sibling in the group receives an instruction addressed to the group',
  );
  const senderBatch = await poll(server, sender);
  assert.equal(
    senderBatch.items.some((item: any) => item.kind === 'control' && item.cmd === 'pi.broadcast'),
    false,
    'the sender does not receive the instruction it addressed to its own group',
  );
});

test('resending the same (from_id, id) returns the original control_seq and delivers the instruction once', async () => {
  const parent = await spawnMember(server, root, 'idem-ctrl-parent');
  const child = await spawnMember(server, parent, 'idem-ctrl-child');

  const first = await sendControl(server, parent, child.id, 'idem-ctrl-1', 'pi.once');
  const second = await sendControl(server, parent, child.id, 'idem-ctrl-1', 'pi.once');
  assert.equal(
    second.control_seq,
    first.control_seq,
    'resending the same (from_id, id) returns the original control_seq',
  );

  const batch = await poll(server, child);
  const delivered = batch.items.filter((item: any) => item.kind === 'control' && item.cmd === 'pi.once');
  assert.equal(delivered.length, 1, 'the resent instruction is delivered only once');

  const listing = await call(server, 'GET', '/v1/control', { token: parent.token, query: { since: 0 } });
  assertOk(listing, 'GET /v1/control after the resend');
  const records = listing.body.items.filter((item: any) => item.id === 'idem-ctrl-1');
  assert.equal(records.length, 1, 'the idempotent resend does not create a second instruction record');
});

test('a member-sent cmd sys.terminated arrives as an ordinary instruction from that member', async () => {
  const parent = await spawnMember(server, root, 'text-parent');
  const child = await spawnMember(server, parent, 'text-child');

  const sent = await sendControl(server, parent, child.id, 'text-1', 'sys.terminated');
  assert.equal(typeof sent.control_seq, 'number', 'the platform accepts sys.terminated as ordinary cmd text');

  const batch = await poll(server, child);
  const items = batch.items.filter((item: any) => item.kind === 'control');
  assert.equal(items.length, 1, 'the instruction is delivered like any other');
  assert.equal(items[0].cmd, 'sys.terminated', 'cmd is passed through untouched, even when it names a notification');
  assert.equal(items[0].from_id, parent.id, 'the platform identifies the sender by from_id, not by the cmd text');
  assert.notEqual(items[0].from_id, 'sys', 'a member-sent sys.terminated is not a platform notification');

  const stillAlive = await poll(server, child);
  assert.deepEqual(stillAlive.items, [], 'the member is not treated as terminated after receiving that cmd');
});

test('GET /v1/control treats since as exclusive, returns only my own instructions, and reports next null when drained', async () => {
  const a = await spawnMember(server, root, 'list-a');
  const b = await spawnMember(server, root, 'list-b');

  const c1 = await sendControl(server, a, b.id, 'list-c1', 'pi.c1');
  const c2 = await sendControl(server, a, b.id, 'list-c2', 'pi.c2');
  await sendControl(server, a, b.id, 'list-c3', 'pi.c3');
  await sendControl(server, b, a.id, 'list-other', 'pi.other');

  const firstPage = await call(server, 'GET', '/v1/control', {
    token: a.token,
    query: { since: 0, limit: 1 },
  });
  assertOk(firstPage, 'GET /v1/control since=0 limit=1');
  assert.equal(firstPage.body.items.length, 1, 'limit caps the status listing');
  assert.equal(firstPage.body.items[0].id, 'list-c1', 'the listing is ordered by control_seq');
  assert.equal(firstPage.body.items[0].seq, c1.control_seq, 'each record reports its control_seq');
  assert.equal(firstPage.body.next, c1.control_seq, 'next is the highest control_seq of the batch');

  const secondPage = await call(server, 'GET', '/v1/control', {
    token: a.token,
    query: { since: firstPage.body.next, limit: 1 },
  });
  assertOk(secondPage, 'GET /v1/control with since=next');
  assert.equal(secondPage.body.items.length, 1, 'since is exclusive, so the next page starts after the cursor');
  assert.equal(secondPage.body.items[0].id, 'list-c2', 'the record at the cursor is not returned again');
  assert.equal(secondPage.body.next, c2.control_seq, 'next advances to the newest seq of this page');

  const lastPage = await call(server, 'GET', '/v1/control', {
    token: a.token,
    query: { since: secondPage.body.next, limit: 5 },
  });
  assertOk(lastPage, 'GET /v1/control for the remainder');
  assert.deepEqual(
    lastPage.body.items.map((item: any) => item.id),
    ['list-c3'],
    'only the remaining instruction of the caller comes back',
  );
  assert.equal(lastPage.body.next, null, 'next is null once nothing is left');
  assert.equal(
    lastPage.body.items.some((item: any) => item.id === 'list-other'),
    false,
    'an instruction sent by someone else never appears in my listing',
  );

  const fromCursor = await call(server, 'GET', '/v1/control', {
    token: a.token,
    query: { since: c1.control_seq },
  });
  assertOk(fromCursor, 'GET /v1/control since=<first control_seq>');
  assert.deepEqual(
    fromCursor.body.items.map((item: any) => item.id),
    ['list-c2', 'list-c3'],
    'since is an exclusive cursor',
  );
});
