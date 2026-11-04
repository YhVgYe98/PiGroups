import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertOk,
  assertStatus,
  bootstrapRoot,
  call,
  poll,
  sendMessage,
  spawnMember,
  startServer,
  type Server,
} from './harness.ts';

test('conversation seqs and the consume cursor survive a restart on the same data directory', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pigroups-persist-'));
  let firstServer: Server | undefined;
  let secondServer: Server | undefined;
  try {
    firstServer = await startServer({ dataDir });
    const root = await bootstrapRoot(firstServer);
    const child = await spawnMember(firstServer, root, 'persist-child');

    const replay = await call(firstServer, 'POST', '/v1/members', {
      token: root.token,
      body: { name: 'persist-child', request_id: 'req-persist-child' },
    });
    assertOk(replay, 'replaying POST /v1/members with the same request_id');
    assert.equal(replay.body.member?.id, child.id, 'a replayed request_id returns the original member');
    assert.equal('token' in replay.body, false, 'a replayed request_id does not return a token again');

    const before = await sendMessage(firstServer, root, child.id, 'delivered before the restart');
    const firstBatch = await poll(firstServer, child);
    assert.ok(
      firstBatch.items.some((item: any) => item.kind === 'message' && item.seq === before.seq),
      'the child consumes the message before the restart',
    );

    const health = await call(firstServer, 'GET', '/v1/health');
    assertOk(health, 'GET /v1/health before the restart');
    const platformId = String(health.body.platform_id);
    assert.match(platformId, /^p_[0-9a-f]{8}$/, 'health identifies the platform directory');

    await firstServer.stop();
    firstServer = undefined;

    secondServer = await startServer({ dataDir, platformId });

    const afterRestart = await poll(secondServer, child);
    assert.deepEqual(afterRestart.items, [], 'nothing is redelivered after the restart');

    const after = await sendMessage(secondServer, root, child.id, 'delivered after the restart');
    assert.equal(after.seq, before.seq + 1, 'the conversation seq continues after the restart');

    const deliveredAfter = await poll(secondServer, child);
    const messages = deliveredAfter.items.filter((item: any) => item.kind === 'message');
    assert.equal(messages.length, 1, 'the message posted after the restart is delivered once');
    assert.equal(messages[0].seq, after.seq, 'the delivered message carries the continued seq');
  } finally {
    if (firstServer) await firstServer.stop();
    if (secondServer) await secondServer.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the storage layer enforces one name for the whole members table, deleted members included', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pigroups-name-index-'));
  let server: Server | undefined;
  try {
    server = await startServer({ dataDir });
    const root = await bootstrapRoot(server);
    const child = await spawnMember(server, root, 'dup');
    const deleted = await call(server, 'DELETE', `/v1/members/${child.id}`, { token: root.token });
    assertStatus(deleted, 200, `DELETE /v1/members/${child.id} for the name dup`);

    const health = await call(server, 'GET', '/v1/health');
    assertOk(health, 'GET /v1/health before opening the database');
    const platformId = String(health.body.platform_id);

    await server.stop();
    server = undefined;

    const db = new DatabaseSync(join(dataDir, 'platforms', platformId, 'pigroups.db'), { readOnly: true });
    try {
      const indexes = db.prepare("PRAGMA index_list('members')").all() as any[];
      const nameIndexes = indexes.filter((index) => index.unique === 1 && indexColumnsOf(db, index.name).includes('name'));
      assert.equal(nameIndexes.length, 1, 'members(name) carries exactly one unique index');
      const nameIndex = nameIndexes[0];
      assert.deepEqual(
        indexColumnsOf(db, nameIndex.name),
        ['name'],
        'the unique index is on name alone, not on (name, status)',
      );
      assert.equal(
        nameIndex.partial,
        0,
        "the unique index is not partial: a deleted member's name stays reserved",
      );
    } finally {
      db.close();
    }
  } finally {
    if (server) await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

/** `PRAGMA index_info(<index>)` yields one row per indexed column, in index order. */
function indexColumnsOf(db: DatabaseSync, indexName: string): string[] {
  const rows = db.prepare(`PRAGMA index_info('${indexName}')`).all() as any[];
  return rows.map((row) => String(row.name));
}
