// The delete that writes `sys.terminated` also writes the row an audit of that delete
// needs. Before e03af1a the row's `to_json` was a bare member id; these tests pin the
// two halves of the repair: tolerant readers (a row can always be read) and the
// one-time backfill at startup (the `?to=` filter compares against the JSON form).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  assertStatus,
  bootstrapRoot,
  call,
  createHuman,
  spawnMember,
  startServer,
} from './harness.ts';

/** The row shape `routes/org.ts` wrote before e03af1a: a bare id, not JSON. */
function insertLegacyTermination(dataDir: string, target: string): void {
  const db = new DatabaseSync(join(dataDir, 'pigroups.db'), { timeout: 5000 });
  try {
    db.prepare(
      `INSERT INTO controls (id, from_id, to_json, cmd, payload_json, reply_to, created_at)
       VALUES (?, 'sys', ?, 'sys.terminated', NULL, NULL, ?)`,
    ).run(`terminate:${target}`, target, Date.now());
  } finally {
    db.close();
  }
}

test('a legacy bare-id control target is healed when the database opens, and ?to= finds it', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pigroups-legacy-'));
  const legacyTarget = 'm_0legacy';
  let server = await startServer({ dataDir });
  t.after(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const root = await bootstrapRoot(server);
  const human = await createHuman(server, 'legacy-human');
  const owner = await spawnMember(server, root, 'legacy-owner');
  const doomed = await spawnMember(server, owner, 'legacy-child');
  // A real delete first: the row the current code writes is JSON and must be unaffected.
  const removed = await call(server, 'DELETE', `/v1/members/${doomed.id}`, { token: owner.token });
  assertStatus(removed, 200, 'DELETE /v1/members/{id}');
  await server.stop();

  // The pre-fix row, written into a stopped database so startup's migration sees it.
  insertLegacyTermination(dataDir, legacyTarget);

  server = await startServer({ dataDir }); // openDatabase() runs the backfill here
  const all = await call(server, 'GET', '/v1/control', {
    token: human.token,
    query: { all: 'true', since: 0 },
  });
  assertStatus(all, 200, 'GET /v1/control?all=true with a legacy row in the table');
  const legacy = all.body.items.find((item: any) => item.id === `terminate:${legacyTarget}`);
  assert.ok(legacy, 'the legacy row is still readable');
  assert.equal(legacy.to, legacyTarget, 'a bare-id target reads back as the id it is');

  // `?to=` compares `to_json` with the JSON form. Only the backfill makes the legacy
  // row match; tolerant parsing alone answers 200 with an empty page here.
  const filtered = await call(server, 'GET', '/v1/control', {
    token: human.token,
    query: { all: 'true', since: 0, to: legacyTarget },
  });
  assertStatus(filtered, 200, 'GET /v1/control?all=true&to=');
  assert.deepEqual(
    filtered.body.items.map((item: any) => item.id),
    [`terminate:${legacyTarget}`],
    'the legacy row is not silently missing from the ?to= filter',
  );
});

test('a bare-id control target written while the server runs is still readable', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pigroups-live-legacy-'));
  const server = await startServer({ dataDir });
  t.after(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const human = await createHuman(server, 'live-legacy-human');
  // After the migration has run: only the tolerant reader can make this row readable.
  // It is not a shape this code writes; it is a shape a reader must not crash on.
  insertLegacyTermination(dataDir, 'm_1live');

  const all = await call(server, 'GET', '/v1/control', {
    token: human.token,
    query: { all: 'true', since: 0 },
  });
  assertStatus(all, 200, 'a row that is not JSON must not 500 the audit');
  const legacy = all.body.items.find((item: any) => item.id === 'terminate:m_1live');
  assert.ok(legacy, 'the row is present in the human view');
  assert.equal(legacy.to, 'm_1live', 'and its target is the text that was stored');

  // The sender's own view reads the same column and must be just as tolerant.
  const owner = await spawnMember(server, await bootstrapRoot(server), 'live-legacy-owner');
  const own = await call(server, 'GET', '/v1/control', { token: owner.token, query: { since: 0 } });
  assertStatus(own, 200, 'the member view reads to_json too');
});
