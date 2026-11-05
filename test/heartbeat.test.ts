import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import {
  assertErrorCode,
  assertOk,
  assertStatus,
  bootstrapRoot,
  call,
  createHuman,
  databasePath,
  spawnMember,
  startServer,
  type Principal,
  type Reply,
  type Server,
} from './harness.ts';
import { openDatabase } from '../src/db.ts';

/** `src/db.ts` as a URL, for the worker threads that open the same file at once. */
const DB_MODULE_URL = new URL('../src/db.ts', import.meta.url).href;

let server: Server;
let root: Principal;

before(async () => {
  server = await startServer();
  root = await bootstrapRoot(server);
});

after(async () => {
  if (server) await server.stop();
});

function heartbeat(server: Server, member: Principal): Promise<Reply> {
  return call(server, 'PUT', `/v1/members/${member.id}/heartbeat`, { token: member.token });
}

test('a heartbeat writes the member heartbeat_at and a second beat moves it forward', async () => {
  const member = await spawnMember(server, root, 'heartbeat-self');

  const before = await call(server, 'GET', `/v1/members/${member.id}`, { token: root.token });
  assertOk(before, 'GET /v1/members/{id} before the first heartbeat');
  assert.equal(before.body.heartbeat_at, null, 'a member that never beat has heartbeat_at null');

  const first = await heartbeat(server, member);
  assertStatus(first, 200, `PUT /v1/members/${member.id}/heartbeat`);
  assert.equal(typeof first.body.heartbeat_at, 'number', 'the heartbeat response carries the time it wrote');

  const firstRead = await call(server, 'GET', `/v1/members/${member.id}`, { token: root.token });
  assertOk(firstRead, 'GET /v1/members/{id} after the first heartbeat');
  assert.equal(firstRead.body.heartbeat_at, first.body.heartbeat_at, 'the stored heartbeat is the returned one');

  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await heartbeat(server, member);
  assertStatus(second, 200, `PUT /v1/members/${member.id}/heartbeat (second time)`);
  assert.ok(
    second.body.heartbeat_at > first.body.heartbeat_at,
    'a second heartbeat moves heartbeat_at forward',
  );

  const secondRead = await call(server, 'GET', `/v1/members/${member.id}`, { token: root.token });
  assertOk(secondRead, 'GET /v1/members/{id} after the second heartbeat');
  assert.equal(secondRead.body.heartbeat_at, second.body.heartbeat_at, 'the later heartbeat is the stored one');
});

test('a member cannot heartbeat for another member; a gone member is 410 and an unknown id is 404', async () => {
  const other = await spawnMember(server, root, 'heartbeat-other');

  const forAnother = await call(server, 'PUT', `/v1/members/${root.id}/heartbeat`, { token: other.token });
  assertStatus(forAnother, 403, 'a member beating for another member');
  assertErrorCode(forAnother, 'forbidden', 'a member beating for another member');

  const parentForChild = await call(server, 'PUT', `/v1/members/${other.id}/heartbeat`, { token: root.token });
  assertStatus(parentForChild, 403, 'a parent beating for its child');
  assertErrorCode(parentForChild, 'forbidden', 'a parent beating for its child');

  const missing = await call(server, 'PUT', '/v1/members/m_000000/heartbeat', { token: root.token });
  assertStatus(missing, 404, 'beating with an id that never existed');
  assertErrorCode(missing, 'not_found', 'beating with an id that never existed');

  const deleted = await call(server, 'DELETE', `/v1/members/${other.id}`, { token: root.token });
  assertStatus(deleted, 200, `DELETE /v1/members/${other.id}`);

  const gone = await heartbeat(server, other);
  assertStatus(gone, 410, 'a gone member beating for itself');
  assertErrorCode(gone, 'member_gone', 'a gone member beating for itself');
});

test('a human cannot send a heartbeat', async () => {
  const member = await spawnMember(server, root, 'heartbeat-human-target');
  const human = await createHuman(server, 'heartbeat-human');

  const refused = await call(server, 'PUT', `/v1/members/${member.id}/heartbeat`, { token: human.token });
  assertStatus(refused, 403, 'a human sending a heartbeat');
  assertErrorCode(refused, 'forbidden', 'a human sending a heartbeat');
  assert.match(
    String(refused.body?.error?.message),
    /heartbeat/,
    'the refusal names the operation: a heartbeat is not a structural operation',
  );

  const after = await call(server, 'GET', `/v1/members/${member.id}`, { token: root.token });
  assertOk(after, 'GET /v1/members/{id} after a refused human heartbeat');
  assert.equal(after.body.heartbeat_at, null, 'the refused heartbeat wrote nothing');
});

test('GET /v1/members/{id} and GET /v1/tree expose heartbeat_at, null before the first beat', async () => {
  const member = await spawnMember(server, root, 'heartbeat-read');

  const detail = await call(server, 'GET', `/v1/members/${member.id}`, { token: root.token });
  assertOk(detail, 'GET /v1/members/{id} before a heartbeat');
  assert.ok('heartbeat_at' in detail.body, 'GET /v1/members/{id} includes heartbeat_at');
  assert.equal(detail.body.heartbeat_at, null, 'a member that never beat exposes heartbeat_at null');
  // §10.3 pins the field list: a derived `online` ("is this member alive?") is
  // forbidden by §4.5 — activity is not liveness, and the platform does not
  // answer it. Adding one has to break this assertion.
  assert.deepEqual(
    Object.keys(detail.body).sort(),
    [
      'child_count',
      'created_at',
      'groups',
      'heartbeat_at',
      'id',
      'is_root',
      'last_seen_at',
      'name',
      'parent_id',
      'server_version',
      'status',
    ],
    'GET /v1/members/{id} returns exactly the §10.3 fields plus server_version',
  );

  const tree = await call(server, 'GET', '/v1/tree', { token: root.token });
  assertOk(tree, 'GET /v1/tree before a heartbeat');
  const node = tree.body.nodes.find((entry: any) => entry.id === member.id);
  assert.ok(node, 'the member is in the tree');
  assert.ok('heartbeat_at' in node, 'GET /v1/tree includes heartbeat_at');
  assert.equal(node.heartbeat_at, null, 'the tree exposes null for a member that never beat');
  assert.deepEqual(
    Object.keys(node).sort(),
    ['child_count', 'heartbeat_at', 'id', 'last_seen_at', 'name', 'parent_id'],
    'a tree node returns exactly the §10.3 fields: no status, no derived online',
  );

  const beat = await heartbeat(server, member);
  assertStatus(beat, 200, `PUT /v1/members/${member.id}/heartbeat`);

  const detailAfter = await call(server, 'GET', `/v1/members/${member.id}`, { token: root.token });
  assertOk(detailAfter, 'GET /v1/members/{id} after a heartbeat');
  assert.equal(detailAfter.body.heartbeat_at, beat.body.heartbeat_at, 'the detail read exposes the beat');

  const treeAfter = await call(server, 'GET', '/v1/tree', { token: root.token });
  assertOk(treeAfter, 'GET /v1/tree after a heartbeat');
  const nodeAfter = treeAfter.body.nodes.find((entry: any) => entry.id === member.id);
  assert.ok(nodeAfter, 'the member is still in the tree');
  assert.equal(nodeAfter.heartbeat_at, beat.body.heartbeat_at, 'the tree read exposes the beat');
});

test('a heartbeat changes heartbeat_at without changing status or the meaning of last_seen_at', async () => {
  const member = await spawnMember(server, root, 'heartbeat-independent');

  const beat = await heartbeat(server, member);
  assertStatus(beat, 200, `PUT /v1/members/${member.id}/heartbeat`);

  const health = await call(server, 'GET', '/v1/health');
  assertOk(health, 'GET /v1/health for the database path');
  const dbPath = databasePath(server.dataDir, String(health.body.platform_id));

  const afterBeat = await call(server, 'GET', `/v1/members/${member.id}`, { token: root.token });
  assertOk(afterBeat, 'GET /v1/members/{id} after a heartbeat');
  assert.equal(afterBeat.body.status, 'alive', 'a heartbeat does not change status');
  const beatAt = beat.body.heartbeat_at;
  const seenAfterBeat = afterBeat.body.last_seen_at;
  assert.equal(typeof seenAfterBeat, 'number', 'an authenticated request refreshed last_seen_at');

  // A request that is not a heartbeat still moves last_seen_at (that is the auth
  // middleware's job) and must leave heartbeat_at alone. The beat's own request
  // cannot show this: it writes both columns, so it cannot say which one moved
  // last_seen_at. A beat-free request can only move last_seen_at.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const whoami = await call(server, 'GET', '/v1/whoami', { token: member.token });
  assertOk(whoami, 'GET /v1/whoami (a request that is not a heartbeat)');
  assert.ok(whoami.body.last_seen_at > seenAfterBeat, 'a request that is not a heartbeat moves last_seen_at');
  const afterWhoami = await call(server, 'GET', `/v1/members/${member.id}`, { token: root.token });
  assertOk(afterWhoami, 'GET /v1/members/{id} after a non-heartbeat request');
  assert.equal(afterWhoami.body.last_seen_at, whoami.body.last_seen_at, 'last_seen_at moved by exactly that request');
  assert.equal(afterWhoami.body.heartbeat_at, beatAt, 'a non-heartbeat request does not move heartbeat_at');
  const lastSeenNow = afterWhoami.body.last_seen_at;

  // Write only heartbeat_at; last_seen_at must not follow it.
  writeColumns(dbPath, member.id, { heartbeat_at: 1_000_000_000_000 });
  const heartbeatOnly = await call(server, 'GET', `/v1/members/${member.id}`, { token: root.token });
  assertOk(heartbeatOnly, 'GET /v1/members/{id} after writing heartbeat_at alone');
  assert.equal(heartbeatOnly.body.heartbeat_at, 1_000_000_000_000, 'heartbeat_at is the written value');
  assert.equal(heartbeatOnly.body.last_seen_at, lastSeenNow, 'writing heartbeat_at does not move last_seen_at');
  assert.equal(heartbeatOnly.body.status, 'alive', 'writing heartbeat_at does not change status');

  // Write only last_seen_at; heartbeat_at must not follow it.
  writeColumns(dbPath, member.id, { last_seen_at: 2_000 });
  const lastSeenOnly = await call(server, 'GET', `/v1/members/${member.id}`, { token: root.token });
  assertOk(lastSeenOnly, 'GET /v1/members/{id} after writing last_seen_at alone');
  assert.equal(lastSeenOnly.body.last_seen_at, 2_000, 'last_seen_at is the written value');
  assert.equal(lastSeenOnly.body.heartbeat_at, 1_000_000_000_000, 'writing last_seen_at does not move heartbeat_at');
  assert.equal(lastSeenOnly.body.status, 'alive', 'writing last_seen_at does not change status');

  // The next real beat moves heartbeat_at again and refreshes last_seen_at,
  // which is its route's existing job, not a second meaning for heartbeat_at.
  const next = await heartbeat(server, member);
  assertStatus(next, 200, `PUT /v1/members/${member.id}/heartbeat after direct column writes`);
  const afterNext = await call(server, 'GET', `/v1/members/${member.id}`, { token: root.token });
  assertOk(afterNext, 'GET /v1/members/{id} after the next heartbeat');
  assert.equal(afterNext.body.heartbeat_at, next.body.heartbeat_at, 'the heartbeat wrote its own column');
  assert.ok(afterNext.body.last_seen_at > 2_000, 'the authenticated request refreshed last_seen_at');
  assert.equal(afterNext.body.status, 'alive', 'a heartbeat still does not change status');
});

test('a database created before heartbeats gains the column when it opens', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pigroups-heartbeat-migration-'));
  let migrating: Server | undefined;
  try {
    migrating = await startServer({ dataDir });
    const oldRoot = await bootstrapRoot(migrating);
    const health = await call(migrating, 'GET', '/v1/health');
    assertOk(health, 'GET /v1/health before dropping heartbeat_at');
    const dbPath = databasePath(dataDir, String(health.body.platform_id));
    await migrating.stop();
    migrating = undefined;

    const oldDb = new DatabaseSync(dbPath);
    try {
      oldDb.exec('ALTER TABLE members DROP COLUMN heartbeat_at');
    } finally {
      oldDb.close();
    }
    const check = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = check.prepare("PRAGMA table_info('members')").all() as Array<{ name: string }>;
      assert.equal(
        columns.some((column) => column.name === 'heartbeat_at'),
        false,
        'the fixture really is a database without the heartbeat column',
      );
    } finally {
      check.close();
    }

    migrating = await startServer({ dataDir });
    const before = await call(migrating, 'GET', `/v1/members/${oldRoot.id}`, { token: oldRoot.token });
    assertOk(before, 'GET /v1/members/{id} after opening the old database');
    assert.equal(before.body.id, oldRoot.id, 'the old row survived the migration');
    assert.equal(before.body.status, 'alive', 'the old row is still alive');
    assert.equal(before.body.heartbeat_at, null, 'the added column starts null for an existing row');

    const beat = await heartbeat(migrating, oldRoot);
    assertStatus(beat, 200, 'a heartbeat on a migrated database');
    assert.equal(typeof beat.body.heartbeat_at, 'number', 'the migrated column accepts a heartbeat');

    const after = await call(migrating, 'GET', `/v1/members/${oldRoot.id}`, { token: oldRoot.token });
    assertOk(after, 'GET /v1/members/{id} after a heartbeat on the migrated database');
    assert.equal(after.body.heartbeat_at, beat.body.heartbeat_at, 'the migrated column reads back the heartbeat');
  } finally {
    if (migrating) await migrating.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('two concurrent opens of the same pre-0.5.0 database both succeed and add one heartbeat_at column', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pigroups-heartbeat-race-'));
  const dbPath = join(dataDir, 'pigroups.db');
  let holder: LockHolder | undefined;
  try {
    // The old shape: the whole current schema, minus the column, in WAL mode.
    openDatabase(dataDir).close();
    dropHeartbeatColumn(dbPath);
    assert.deepEqual(heartbeatColumns(dbPath), [], 'the fixture really is a database without the heartbeat column');

    // `openDatabase` must tolerate two concurrent opens even though `main.ts`
    // now takes the start lock for a platform with no endpoint record: the lock
    // covers the CLI's first start, not every caller of this function.
    // The holder opens the microsecond window between "no column" and the ALTER
    // that the race needs, and adds the column itself just before releasing it.
    holder = startLockHolder(dbPath);
    await holder.ready;

    const opens = [openInWorker(dataDir), openInWorker(dataDir)];
    await Promise.all(opens.map((open) => open.started));
    // Both workers are past their schema read and parked on the holder's write
    // lock: one ALTER away from the old failure, or one BEGIN IMMEDIATE away
    // from the fix's re-read.
    await new Promise((resolve) => setTimeout(resolve, 150));
    holder.migrate();

    const [first, second] = await Promise.all(opens.map((open) => open.result));
    assert.equal(first.ok, true, `the first concurrent open succeeded (${first.error ?? 'no error'})`);
    assert.equal(second.ok, true, `the second concurrent open succeeded (${second.error ?? 'no error'})`);
    await holder.done;

    assert.deepEqual(heartbeatColumns(dbPath), ['heartbeat_at'], 'the file gained the column exactly once');
  } finally {
    holder?.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
});

/** A second process that holds the table's write lock until told to migrate. */
type LockHolder = {
  /** Resolves once the write transaction is open, so an opener queues behind it. */
  ready: Promise<void>;
  /** Adds the column and commits, releasing every opener parked behind the lock. */
  migrate: () => void;
  done: Promise<void>;
  kill: () => void;
};

function startLockHolder(databasePathname: string): LockHolder {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.env.PIGROUPS_TEST_DB, { timeout: 5000 });
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    process.stdin.once('data', () => {
      db.exec('ALTER TABLE members ADD COLUMN heartbeat_at INTEGER');
      db.exec('COMMIT');
      db.close();
      process.stdout.write('committed\\n');
      process.exit(0);
    });
  `;
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, PIGROUPS_TEST_DB: databasePathname },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ready = new Promise<void>((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout?.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`the lock holder exited before locking (code ${code}): ${stderr}`)),
    );
  });
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    ready,
    migrate: () => child.stdin?.write('migrate\n'),
    done,
    kill: () => {
      child.kill('SIGKILL');
    },
  };
}

/** One `openDatabase` in its own thread, so two of them really run at once. */
type ConcurrentOpen = {
  started: Promise<void>;
  result: Promise<{ ok: boolean; error?: string }>;
};

function openInWorker(dataDir: string): ConcurrentOpen {
  const script = `
    const { parentPort, workerData } = require('node:worker_threads');
    parentPort.postMessage({ phase: 'started' });
    import(workerData.moduleUrl).then((module) => {
      try {
        module.openDatabase(workerData.dataDir).close();
        parentPort.postMessage({ phase: 'result', ok: true });
      } catch (error) {
        parentPort.postMessage({ phase: 'result', ok: false, error: String(error && error.message) });
      }
    });
  `;
  let markStarted: () => void = () => {};
  let markResult: (value: { ok: boolean; error?: string }) => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const result = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    markResult = resolve;
  });
  const worker = new Worker(script, { eval: true, workerData: { moduleUrl: DB_MODULE_URL, dataDir } });
  worker.on('message', (message: { phase: string; ok?: boolean; error?: string }) => {
    if (message.phase === 'started') markStarted();
    else markResult({ ok: message.ok === true, error: message.error });
  });
  worker.once('error', (error) => markResult({ ok: false, error: `the worker failed: ${String(error)}` }));
  worker.once('exit', (code) =>
    markResult({ ok: false, error: `the worker exited before reporting (code ${code})` }),
  );
  void result.then(() => worker.terminate());
  return { started, result };
}

function dropHeartbeatColumn(databasePathname: string): void {
  const db = new DatabaseSync(databasePathname, { timeout: 5000 });
  try {
    db.exec('ALTER TABLE members DROP COLUMN heartbeat_at');
  } finally {
    db.close();
  }
}

function heartbeatColumns(databasePathname: string): string[] {
  const db = new DatabaseSync(databasePathname, { readOnly: true });
  try {
    const columns = db.prepare("PRAGMA table_info('members')").all() as Array<{ name: string }>;
    return columns.map((column) => column.name).filter((name) => name === 'heartbeat_at');
  } finally {
    db.close();
  }
}

/** Write specific member columns directly, to show which request touches which column. */
function writeColumns(databasePathname: string, memberId: string, values: Record<string, number>): void {
  const db = new DatabaseSync(databasePathname, { timeout: 5000 });
  try {
    const assignments = Object.keys(values)
      .map((column) => `${column} = ?`)
      .join(', ');
    db.prepare(`UPDATE members SET ${assignments} WHERE id = ?`).run(...Object.values(values), memberId);
  } finally {
    db.close();
  }
}
