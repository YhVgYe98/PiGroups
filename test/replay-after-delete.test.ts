import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertOk,
  assertStatus,
  bootstrapRoot,
  call,
  dmConversation,
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

test('a message resent with its client_msg_id after the recipient was deleted returns the original seq, not 410', async () => {
  const target = await spawnMember(server, root, 'replay-dm-target');

  const first = await sendMessage(server, root, target.id, 'the brief that must not be lost', {
    client_msg_id: 'b1',
  });

  const deleted = await call(server, 'DELETE', `/v1/members/${target.id}`, { token: root.token });
  assertStatus(deleted, 200, `DELETE /v1/members/${target.id}`);

  const resent = await call(server, 'POST', '/v1/messages', {
    token: root.token,
    body: { to: target.id, body: 'the brief that must not be lost', client_msg_id: 'b1' },
  });
  assertStatus(resent, 200, 'resending a client_msg_id after the recipient is gone');
  assert.equal(
    resent.body.seq,
    first.seq,
    'the resend returns the original seq: the idempotency key is consulted before the target is validated',
  );
  assert.equal(resent.body.to, dmConversation(root.id, target.id), 'the replayed message keeps its conversation');
});

test('an instruction resent with its (from_id, id) after the target was deleted returns the original control_seq, not 410', async () => {
  const parent = await spawnMember(server, root, 'replay-ctrl-parent');
  const child = await spawnMember(server, parent, 'replay-ctrl-child');

  const first = await call(server, 'POST', '/v1/control', {
    token: parent.token,
    body: { to: child.id, id: 'k1', cmd: 'pi.once' },
  });
  assertOk(first, 'POST /v1/control');
  assert.equal(typeof first.body.control_seq, 'number', 'POST /v1/control returns a control_seq');

  const deleted = await call(server, 'DELETE', `/v1/members/${child.id}`, { token: parent.token });
  assertStatus(deleted, 200, `DELETE /v1/members/${child.id}`);

  const resent = await call(server, 'POST', '/v1/control', {
    token: parent.token,
    body: { to: child.id, id: 'k1', cmd: 'pi.once' },
  });
  assertStatus(resent, 200, 'resending an (from_id, id) after the target is gone');
  assert.equal(
    resent.body.control_seq,
    first.body.control_seq,
    'the resend returns the original control_seq: the idempotency key is consulted before the target is validated',
  );
});
