import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertErrorCode,
  assertOk,
  assertStatus,
  bootstrapRoot,
  call,
  conversationId,
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

test('creating a member returns a token and a direct child, and the owner group exists only after that child exists', async () => {
  const childless = await call(server, 'GET', `/v1/members/${root.id}`, { token: root.token });
  assertOk(childless, 'GET /v1/members/{id} of a childless member');
  assert.equal(childless.body.child_count, 0, 'a freshly bootstrapped root has no children');
  assert.deepEqual(
    (childless.body.groups ?? []).map(conversationId),
    [],
    'a member with no child owns no group, so it belongs to none',
  );

  const tooEarly = await call(server, 'POST', '/v1/messages', {
    token: root.token,
    body: { to: groupConversation(root.id), body: 'nobody is listening yet' },
  });
  assertStatus(tooEarly, 404, 'posting to g:<owner> while the owner still has no child');
  assertErrorCode(tooEarly, 'no_such_group', 'posting to g:<owner> while the owner still has no child');

  const child = await spawnMember(server, root, 'org-child');
  assert.match(String(child.id), /^m_[0-9a-f]{6}$/, 'a created member gets an m_<6 hex> id');
  assert.equal(typeof child.token, 'string', 'POST /v1/members returns a token');
  assert.ok(child.token.length > 0, 'the new member token is not empty');
  assert.notEqual(child.token, root.token, 'each member has its own token');

  const childDetail = await call(server, 'GET', `/v1/members/${child.id}`, { token: root.token });
  assertOk(childDetail, 'GET /v1/members/{id} of the new member');
  assert.equal(childDetail.body.parent_id, root.id, 'the creator is the parent, so the child is a direct child');

  const ownerDetail = await call(server, 'GET', `/v1/members/${root.id}`, { token: root.token });
  assertOk(ownerDetail, 'GET /v1/members/{id} of the owner');
  assert.equal(ownerDetail.body.child_count, 1, 'the owner now has one live child');
  assert.ok(
    (ownerDetail.body.groups ?? []).map(conversationId).includes(groupConversation(root.id)),
    'the owner now belongs to its own group g:<owner>',
  );

  const posted = await sendMessage(server, root, groupConversation(root.id), 'the group is live now');
  assert.equal(posted.to, groupConversation(root.id), 'the message lands in g:<owner>');
});

test('the tree lists only live members, so a deleted member is absent', async () => {
  const branch = await spawnMember(server, root, 'tree-branch');
  const leaf = await spawnMember(server, branch, 'tree-leaf');

  const first = await call(server, 'GET', '/v1/tree', { token: root.token });
  assertOk(first, 'GET /v1/tree');
  assert.ok(Array.isArray(first.body.nodes), 'GET /v1/tree returns a nodes array');

  const nodes: any[] = first.body.nodes;
  const ids = nodes.map((node) => node.id);
  assert.ok(ids.includes(root.id), 'the tree contains the root');
  assert.ok(ids.includes(branch.id), 'the tree contains a live member');
  assert.ok(ids.includes(leaf.id), 'the tree contains a live descendant');

  const branchNode = nodes.find((node) => node.id === branch.id);
  assert.equal(branchNode.parent_id, root.id, 'the tree reports the parent edge');
  assert.equal(branchNode.child_count, 1, 'the tree reports the live child count');
  assert.equal('status' in branchNode, false, 'the tree only lists live members, so nodes carry no status');

  const deleted = await call(server, 'DELETE', `/v1/members/${branch.id}`, { token: root.token });
  assertOk(deleted, `DELETE /v1/members/${branch.id}`);

  const second = await call(server, 'GET', '/v1/tree', { token: root.token });
  assertOk(second, 'GET /v1/tree after the deletion');
  const remaining: string[] = second.body.nodes.map((node: any) => node.id);
  assert.equal(remaining.includes(branch.id), false, 'a deleted member is absent from the tree');
  assert.equal(remaining.includes(leaf.id), false, 'the deleted subtree is absent from the tree');
  assert.ok(remaining.includes(root.id), 'the surviving root is still listed');
});
