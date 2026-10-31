import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertErrorCode,
  assertOk,
  assertStatus,
  bootstrapRoot,
  call,
  dmConversation,
  groupConversation,
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

test('§3.5: an outsider cannot post to a group it is not in, and an unrelated member cannot read someone else\'s DM', async () => {
  const a = await spawnMember(server, root, 'gate-a');
  const b = await spawnMember(server, root, 'gate-b');
  const a1 = await spawnMember(server, a, 'gate-a1');
  await spawnMember(server, b, 'gate-b1');

  const outsiderPost = await call(server, 'POST', '/v1/messages', {
    token: a1.token,
    body: { to: groupConversation(b.id), body: 'not my group' },
  });
  assertStatus(outsiderPost, 403, 'a member posting to a group it is not in');
  assertErrorCode(outsiderPost, 'forbidden', 'a member posting to a group it is not in');

  const dm = await sendMessage(server, root, a.id, 'private between root and a');
  assert.equal(dm.to, dmConversation(root.id, a.id), 'the DM conversation id is derived from the two members');

  const outsiderRead = await call(server, 'GET', '/v1/messages', {
    token: a1.token,
    query: { to: dmConversation(root.id, a.id) },
  });
  assertStatus(outsiderRead, 403, 'a member reading a DM between two other members');
  assertErrorCode(outsiderRead, 'forbidden', 'a member reading a DM between two other members');
});

test('DELETE of the root is 409 root_protected, a cross-subtree delete is 403, and a repeat delete returns the same terminated ids', async () => {
  const a = await spawnMember(server, root, 'del-a');
  const b = await spawnMember(server, root, 'del-b');
  const b1 = await spawnMember(server, b, 'del-b1');
  await spawnMember(server, a, 'del-a1');

  const rootDelete = await call(server, 'DELETE', `/v1/members/${root.id}`, { token: root.token });
  assertStatus(rootDelete, 409, 'DELETE of the root');
  assertErrorCode(rootDelete, 'root_protected', 'DELETE of the root');

  const crossSubtree = await call(server, 'DELETE', `/v1/members/${b1.id}`, { token: a.token });
  assertStatus(crossSubtree, 403, 'DELETE of a member outside my subtree');
  assertErrorCode(crossSubtree, 'forbidden', 'DELETE of a member outside my subtree');

  const first = await call(server, 'DELETE', `/v1/members/${b.id}`, { token: root.token });
  assertStatus(first, 200, 'DELETE of a direct child subtree');
  const terminated = [...first.body.terminated].sort();
  assert.deepEqual(terminated, [b.id, b1.id].sort(), 'the whole subtree is reported as terminated');

  const repeat = await call(server, 'DELETE', `/v1/members/${b.id}`, { token: root.token });
  assertStatus(repeat, 200, 'repeating the DELETE of an already gone subtree');
  assert.deepEqual(
    [...repeat.body.terminated].sort(),
    terminated,
    'a repeated DELETE returns the same terminated ids, so a retry can tell which batch was deleted',
  );
});

test('a deleted member\'s name stays reserved, so reusing it is 409 name_taken', async () => {
  const dup = await spawnMember(server, root, 'dup');

  const deleted = await call(server, 'DELETE', `/v1/members/${dup.id}`, { token: root.token });
  assertStatus(deleted, 200, `DELETE /v1/members/${dup.id}`);

  const reuse = await call(server, 'POST', '/v1/members', {
    token: root.token,
    body: { name: 'dup', request_id: 'dup-second' },
  });
  assertStatus(reuse, 409, 'POST /v1/members with the name of a deleted member');
  assertErrorCode(reuse, 'name_taken', 'POST /v1/members with the name of a deleted member');
});

test('POST /v1/members/{id}/token replaces the token, and only the direct parent may call it', async () => {
  const parent = await spawnMember(server, root, 'tok-parent');
  const child = await spawnMember(server, parent, 'tok-child');
  const other = await spawnMember(server, root, 'tok-other');

  const rotated = await call(server, 'POST', `/v1/members/${child.id}/token`, { token: parent.token });
  assertOk(rotated, `POST /v1/members/${child.id}/token`);
  assert.equal(typeof rotated.body.token, 'string', 'reissuing a token returns a token');
  assert.ok(rotated.body.token.length > 0, 'the reissued token is not empty');
  assert.notEqual(rotated.body.token, child.token, 'the reissued token is a new token');

  const withNew = await call(server, 'GET', '/v1/whoami', { token: rotated.body.token });
  assertOk(withNew, 'GET /v1/whoami with the reissued token');
  assert.equal(withNew.body.member?.id, child.id, 'the reissued token still names the same member');

  const withOld = await call(server, 'GET', '/v1/whoami', { token: child.token });
  assertStatus(withOld, 401, 'GET /v1/whoami with the replaced token');
  assertErrorCode(withOld, 'invalid_token', 'GET /v1/whoami with the replaced token');

  const notParent = await call(server, 'POST', `/v1/members/${child.id}/token`, { token: other.token });
  assertStatus(notParent, 403, 'a member reissuing the token of a member that is not its direct child');
  assertErrorCode(notParent, 'forbidden', 'a member reissuing the token of a member that is not its direct child');
});
