import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertOk,
  bootstrapRoot,
  call,
  poll,
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
