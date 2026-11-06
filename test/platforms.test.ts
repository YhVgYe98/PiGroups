/**
 * Platform layout, selection, endpoint claims and startup races, mostly through
 * the CLI. A few tests call `readEndpoint` directly; everything else spawns
 * `src/main.ts` and observes it over HTTP.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createConnection } from 'node:net';
import { readEndpoint } from '../src/endpoint.ts';

import {
  assertErrorCode,
  assertOk,
  assertStatus,
  bootstrapRoot,
  call,
  createHuman,
  databasePath,
  dmConversation,
  endpointPath,
  deadPid,
  freePortNumber,
  holdAddress,
  holdHttpAt,
  holdHttpPort,
  holdScriptedHealth,
  holdPort,
  metaRows,
  platformDirs,
  poll,
  readEndpointRecord,
  runToExit,
  sendControl,
  sendMessage,
  spawnMember,
  spawnRaw,
  startServer,
  type Server,
} from './harness.ts';

const PACKAGE_JSON = new URL('../package.json', import.meta.url);

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(PACKAGE_JSON, 'utf8')) as { version: string };
  return manifest.version;
}

async function health(server: Server): Promise<Record<string, any>> {
  const reply = await call(server, 'GET', '/v1/health');
  assertOk(reply, 'GET /v1/health');
  return reply.body;
}

async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(200, () => done(false));
  });
}

test('an empty data root creates platforms/<platform_id>/pigroups.db and stores its identity in meta', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-empty-'));
  const server = await startServer({ dataDir: dataRoot });
  try {
    const healthBody = await health(server);
    assert.match(String(healthBody.platform_id), /^p_[0-9a-f]{8}$/, 'health reports the generated platform id');
    assert.deepEqual(
      Object.keys(healthBody).sort(),
      ['platform_id', 'server_version', 'status', 'uptime_ms', 'version'],
      'health reports exactly the old fields plus platform_id: nothing was removed or renamed',
    );

    assert.deepEqual(await platformDirs(dataRoot), [healthBody.platform_id], 'the data root holds exactly that platform');
    assert.ok(existsSync(databasePath(dataRoot, healthBody.platform_id)), 'the database lives under platforms/<id>');
    assert.ok(
      existsSync(join(dataRoot, 'platforms', healthBody.platform_id, 'server.log')),
      'the platform directory also carries server.log',
    );

    const meta = metaRows(databasePath(dataRoot, healthBody.platform_id));
    assert.equal(meta.platform_id, healthBody.platform_id, 'meta.platform_id is the directory name');
    assert.match(meta.created_at, /^\d+$/, 'meta.created_at is Unix milliseconds');
    assert.equal(meta.server_version, await packageVersion(), 'meta.server_version is the running package version');
    assert.deepEqual(
      Object.keys(meta).sort(),
      ['created_at', 'platform_id', 'server_version'],
      'meta carries exactly the three identity/observation keys',
    );
  } finally {
    await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('restarting with PIGROUPS_PLATFORM_ID reuses that platform directory and its data', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-select-'));
  let server = await startServer({ dataDir: dataRoot });
  try {
    const root = await bootstrapRoot(server);
    const platformId = String((await health(server)).platform_id);

    await server.stop();
    server = await startServer({ dataDir: dataRoot, platformId });

    const restarted = await health(server);
    assert.equal(restarted.platform_id, platformId, 'the explicit platform id selects the same platform');

    const whoami = await call(server, 'GET', '/v1/whoami', { token: root.token });
    assertOk(whoami, 'GET /v1/whoami after restarting the selected platform');
    assert.equal(whoami.body.member.id, root.id, 'the root member survived the restart');
    assert.equal(whoami.body.server.platform_id, platformId, 'whoami carries the platform id');
  } finally {
    await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('without PIGROUPS_PLATFORM_ID a data root with exactly one platform is reused', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-single-'));
  let server = await startServer({ dataDir: dataRoot });
  try {
    const platformId = String((await health(server)).platform_id);
    await server.stop();

    server = await startServer({ dataDir: dataRoot });
    assert.equal((await health(server)).platform_id, platformId, 'the only platform is reused without an explicit id');
  } finally {
    await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('without PIGROUPS_PLATFORM_ID a data root with two platforms refuses to start and lists both ids', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-ambiguous-'));
  const first = 'p_aaaaaaaa';
  const second = 'p_bbbbbbbb';
  const firstServer = await startServer({ dataDir: dataRoot, platformId: first });
  await firstServer.stop();
  const secondServer = await startServer({ dataDir: dataRoot, platformId: second });
  await secondServer.stop();
  try {
    assert.deepEqual(await platformDirs(dataRoot), [first, second], 'both platforms exist under the data root');

    const result = await runToExit({ dataDir: dataRoot });
    assert.equal(result.code, 1, 'the server must not start when the choice is ambiguous');
    assert.equal(result.stdout.trim(), '', 'a refused startup does not print a readiness line');
    assert.ok(result.stderr.includes(first), `the error lists ${first}: ${result.stderr}`);
    assert.ok(result.stderr.includes(second), `the error lists ${second}: ${result.stderr}`);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('PIGROUPS_PLATFORM_ID that disagrees with the database identity refuses to start and names both ids', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-mismatch-'));
  const storedId = 'p_1200aaaa';
  const requestedId = 'p_3400bbbb';
  const server = await startServer({ dataDir: dataRoot, platformId: storedId });
  await server.stop();

  try {
    // A moved or copied platform directory must not be accepted as a new identity.
    await rename(join(dataRoot, 'platforms', storedId), join(dataRoot, 'platforms', requestedId));

    const result = await runToExit({ dataDir: dataRoot, platformId: requestedId });
    assert.equal(result.code, 1, 'the server must not start on another platform\'s database');
    assert.equal(result.stdout.trim(), '', 'a refused startup does not print a readiness line');
    assert.ok(result.stderr.includes(storedId), `the error names the stored id ${storedId}: ${result.stderr}`);
    assert.ok(result.stderr.includes(requestedId), `the error names the requested id ${requestedId}: ${result.stderr}`);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('two platforms under one data root keep separate trees, messages, tokens and instructions', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-isolated-'));
  const firstId = 'p_aaaaaaa1';
  const secondId = 'p_bbbbbbb2';
  const first = await startServer({ dataDir: dataRoot, platformId: firstId });
  const second = await startServer({ dataDir: dataRoot, platformId: secondId });
  try {
    const firstRoot = await bootstrapRoot(first, 'root');
    const firstChild = await spawnMember(first, firstRoot, 'shared-child');
    const secondRoot = await bootstrapRoot(second, 'root');
    const secondChild = await spawnMember(second, secondRoot, 'shared-child');

    await sendMessage(first, firstRoot, firstChild.id, 'first-platform-only');
    await sendMessage(second, secondRoot, secondChild.id, 'second-platform-only');

    const firstBatch = await poll(first, firstChild);
    const firstMessages = firstBatch.items.filter((item: any) => item.kind === 'message');
    assert.equal(firstMessages.length, 1, 'the first child gets exactly its own message');
    assert.match(String(firstMessages[0].body), /first-platform-only/);
    assert.doesNotMatch(String(firstMessages[0].body), /second-platform-only/);

    const secondBatch = await poll(second, secondChild);
    const secondMessages = secondBatch.items.filter((item: any) => item.kind === 'message');
    assert.equal(secondMessages.length, 1, 'the second child gets exactly its own message');
    assert.match(String(secondMessages[0].body), /second-platform-only/);
    assert.doesNotMatch(String(secondMessages[0].body), /first-platform-only/);

    // Reading history on one platform must not reveal the other platform's row.
    const history = await call(first, 'GET', '/v1/messages', {
      token: firstRoot.token,
      query: { to: dmConversation(firstRoot.id, firstChild.id) },
    });
    assertOk(history, 'GET /v1/messages on the first platform');
    assert.match(JSON.stringify(history.body), /first-platform-only/);
    assert.doesNotMatch(JSON.stringify(history.body), /second-platform-only/);

    // A token belongs to one platform's database and nowhere else.
    const foreignRoot = await call(second, 'GET', '/v1/whoami', { token: firstRoot.token });
    assertStatus(foreignRoot, 401, 'the first platform root token on the second platform');
    assertErrorCode(foreignRoot, 'invalid_token', 'the first platform root token on the second platform');
    const foreignChild = await call(second, 'GET', '/v1/poll', {
      token: firstChild.token,
      query: { wait: 0 },
    });
    assertStatus(foreignChild, 401, 'the first platform child token on the second platform');
    assertErrorCode(foreignChild, 'invalid_token', 'the first platform child token on the second platform');

    // An instruction written on one platform must not be delivered on the other.
    await sendControl(first, firstRoot, firstChild.id, 'c-isolated', 'pi.report', {
      payload: { status: 'done' },
    });
    const firstControl = await poll(first, firstChild);
    assert.equal(
      firstControl.items.filter((item: any) => item.kind === 'control').length,
      1,
      'the first platform delivers its own instruction',
    );
    const secondControl = await poll(second, secondChild);
    assert.deepEqual(secondControl.items, [], 'the second platform sees nothing written on the first');
    assert.equal(secondControl.control_pending, 0, 'the second platform has no pending instruction from the first');

    const secondHuman = await createHuman(second, 'iso-human');
    const allControls = await call(second, 'GET', '/v1/control', {
      token: secondHuman.token,
      query: { all: 'true' },
    });
    assertOk(allControls, 'GET /v1/control?all=true on the second platform');
    assert.deepEqual(allControls.body.items, [], 'a human on the second platform cannot read the first platform instructions');

    assert.equal((await health(first)).platform_id, firstId);
    assert.equal((await health(second)).platform_id, secondId);
  } finally {
    await first.stop();
    await second.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  parent_id     TEXT REFERENCES members(id),
  is_root       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  request_id    TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  gone_at       INTEGER,
  gone_reason   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_member_name ON members(name);
CREATE UNIQUE INDEX IF NOT EXISTS ux_root ON members(is_root) WHERE is_root = 1;
CREATE UNIQUE INDEX IF NOT EXISTS ux_spawn_idem ON members(parent_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_member_token ON members(token_hash);

CREATE TABLE IF NOT EXISTS humans (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  token_hash    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_human_token ON humans(token_hash);

CREATE TABLE IF NOT EXISTS conversation_seqs (
  conv_id       TEXT PRIMARY KEY,
  last_seq      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  conv_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  sender_id     TEXT NOT NULL,
  sender_kind   TEXT NOT NULL,
  client_msg_id TEXT,
  body          TEXT NOT NULL,
  meta_json     TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (conv_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_idem ON messages(sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mentions (
  conv_id       TEXT NOT NULL,
  msg_seq       INTEGER NOT NULL,
  member_id     TEXT NOT NULL,
  PRIMARY KEY (conv_id, msg_seq, member_id)
);

CREATE TABLE IF NOT EXISTS inbox (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id     TEXT NOT NULL,
  conv_id       TEXT NOT NULL,
  msg_seq       INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_inbox_member ON inbox(member_id, seq);

CREATE TABLE IF NOT EXISTS member_cursors (
  member_id     TEXT PRIMARY KEY,
  last_seq      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS controls (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL,
  from_id       TEXT NOT NULL,
  to_json       TEXT NOT NULL,
  cmd           TEXT NOT NULL,
  payload_json  TEXT,
  reply_to      TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(from_id, id),
  CHECK (length(cmd) BETWEEN 1 AND 200)
);

CREATE TABLE IF NOT EXISTS control_receipts (
  control_seq   INTEGER NOT NULL,
  to_id         TEXT NOT NULL,
  state         TEXT NOT NULL,
  delivered_at  INTEGER,
  PRIMARY KEY (control_seq, to_id)
);
CREATE INDEX IF NOT EXISTS ix_receipts_pending ON control_receipts(to_id, state);
`;

const OLD_TABLES = [
  'members',
  'humans',
  'conversation_seqs',
  'messages',
  'mentions',
  'inbox',
  'member_cursors',
  'controls',
  'control_receipts',
];

function tableCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of OLD_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    counts[table] = Number(row.count);
  }
  return counts;
}

/** A database with the 0.2.0 table set, real rows, and no `meta` table. */
function writeOldDatabase(databasePathname: string): void {
  mkdirSyncParent(databasePathname);
  const db = new DatabaseSync(databasePathname, { timeout: 5000 });
  try {
    db.exec(OLD_SCHEMA);
    const createdAt = 1_760_000_000_000;
    db.prepare(
      `INSERT INTO members (id, name, parent_id, is_root, status, token_hash, request_id, created_at)
       VALUES ('m_r00t01', 'old-root', NULL, 1, 'alive', 'root-hash', NULL, ?)`,
    ).run(createdAt);
    db.prepare(
      `INSERT INTO members (id, name, parent_id, is_root, status, token_hash, request_id, created_at)
       VALUES ('m_ch1ld2', 'old-child', 'm_r00t01', 0, 'alive', 'child-hash', NULL, ?)`,
    ).run(createdAt);
    db.prepare(
      `INSERT INTO humans (id, name, token_hash, created_at) VALUES ('h_human1', 'old-human', 'human-hash', ?)`,
    ).run(createdAt);
    db.prepare("INSERT INTO conversation_seqs (conv_id, last_seq) VALUES ('g:m_r00t01', 1)").run();
    db.prepare(
      `INSERT INTO messages (conv_id, seq, sender_id, sender_kind, client_msg_id, body, meta_json, created_at)
       VALUES ('g:m_r00t01', 1, 'm_r00t01', 'member', NULL, 'a row from 0.2.0', NULL, ?)`,
    ).run(createdAt);
    db.prepare(
      "INSERT INTO mentions (conv_id, msg_seq, member_id) VALUES ('g:m_r00t01', 1, 'm_ch1ld2')",
    ).run();
    db.prepare(
      `INSERT INTO inbox (member_id, conv_id, msg_seq, created_at) VALUES ('m_ch1ld2', 'g:m_r00t01', 1, ?)`,
    ).run(createdAt);
    db.prepare("INSERT INTO member_cursors (member_id, last_seq) VALUES ('m_ch1ld2', 1)").run();
    db.prepare(
      `INSERT INTO controls (id, from_id, to_json, cmd, payload_json, reply_to, created_at)
       VALUES ('old-control', 'sys', '"m_ch1ld2"', 'sys.terminated', NULL, NULL, ?)`,
    ).run(createdAt);
    db.prepare(
      "INSERT INTO control_receipts (control_seq, to_id, state, delivered_at) VALUES (1, 'm_ch1ld2', 'pending', NULL)",
    ).run();
  } finally {
    db.close();
  }
}

function mkdirSyncParent(path: string): void {
  // The test writes the platform directory directly, as an older release would have left it.
  mkdirSync(dirname(path), { recursive: true });
}

test('a 0.2.0 database without meta opens without losing rows and gains the three meta keys', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-old-'));
  const platformId = 'p_0123abcd';
  const databasePathname = databasePath(dataRoot, platformId);
  try {
    await assertOldDatabaseSurvivesAnOpen(dataRoot, platformId, databasePathname);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function assertOldDatabaseSurvivesAnOpen(
  dataRoot: string,
  platformId: string,
  databasePathname: string,
): Promise<void> {
  writeOldDatabase(databasePathname);

  const oldDb = new DatabaseSync(databasePathname, { readOnly: true });
  const before = tableCounts(oldDb);
  oldDb.close();
  assert.equal(before.members, 2, 'the fixture starts with two members');
  assert.equal(before.messages, 1, 'the fixture starts with one message');

  const adoptedAt = Date.now();
  const server = await startServer({ dataDir: dataRoot, platformId });
  try {
    const healthBody = await health(server);
    assert.equal(healthBody.platform_id, platformId, 'the old database was opened as the selected platform');
  } finally {
    await server.stop();
  }

  const openedDb = new DatabaseSync(databasePathname, { readOnly: true });
  try {
    assert.deepEqual(tableCounts(openedDb), before, 'opening the old database preserves every row of every 0.2.0 table');
  } finally {
    openedDb.close();
  }

  const meta = metaRows(databasePathname);
  assert.equal(
    meta.platform_id,
    platformId,
    'the adopted database records the id the explicit PIGROUPS_PLATFORM_ID selected',
  );
  assert.equal(
    meta.created_at === '1760000000000',
    false,
    'an adopted legacy database does not invent a creation time from its rows',
  );
  assert.ok(
    Number(meta.created_at) >= adoptedAt - 1000 && Number(meta.created_at) <= Date.now() + 1000,
    `opening the old database records when 0.3.0 took it over as Unix milliseconds, got ${meta.created_at}`,
  );
  assert.equal(meta.server_version, await packageVersion(), 'the old database records the opening package version');
  assert.deepEqual(
    Object.keys(meta).sort(),
    ['created_at', 'platform_id', 'server_version'],
    'meta carries exactly the three identity/observation keys',
  );
}

test('meta.server_version is overwritten with the package version on every startup', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-version-'));
  let server = await startServer({ dataDir: dataRoot });
  let platformId = '';
  try {
    platformId = String((await health(server)).platform_id);
  } finally {
    await server.stop();
  }

  const databasePathname = databasePath(dataRoot, platformId);
  const db = new DatabaseSync(databasePathname, { timeout: 5000 });
  try {
    db.prepare("UPDATE meta SET value = '0.0.0' WHERE key = 'server_version'").run();
  } finally {
    db.close();
  }
  assert.equal(metaRows(databasePathname).server_version, '0.0.0', 'the fixture starts with an old observed version');

  server = await startServer({ dataDir: dataRoot, platformId });
  try {
    assert.equal(
      metaRows(databasePathname).server_version,
      await packageVersion(),
      'opening the database overwrites meta.server_version with this server version',
    );
  } finally {
    await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('GET /v1/whoami carries server.platform_id for both a member and a human', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-whoami-'));
  const server = await startServer({ dataDir: dataRoot });
  try {
    const root = await bootstrapRoot(server);
    const platformId = String((await health(server)).platform_id);
    const member = await call(server, 'GET', '/v1/whoami', { token: root.token });
    assertOk(member, 'GET /v1/whoami as a member');
    assert.equal(member.body.server?.platform_id, platformId, 'the member whoami carries server.platform_id');
    assert.equal(member.body.server?.version, await packageVersion(), 'the old server.version field is unchanged');

    const humanPrincipal = await createHuman(server, 'whoami-human');
    const human = await call(server, 'GET', '/v1/whoami', { token: humanPrincipal.token });
    assertOk(human, 'GET /v1/whoami as a human');
    assert.equal(human.body.server?.platform_id, platformId, 'the human whoami carries server.platform_id');
    assert.equal(human.body.server?.version, await packageVersion(), 'the old server.version field is unchanged');
  } finally {
    await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

/** A 0.2.0 database whose newest row exists only in an uncheckpointed WAL. */
test('a root database next to an existing platform refuses to start instead of guessing', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-adopt-conflict-'));
  const platformId = 'p_0000feed';
  const rootDb = join(dataRoot, 'pigroups.db');
  try {
    const existing = await startServer({ dataDir: dataRoot, platformId });
    await existing.stop();
    writeOldDatabase(rootDb);
    writeFileSync(`${rootDb}-wal`, 'fake-wal-contents');

    const result = await runToExit({ dataDir: dataRoot });
    assert.equal(result.code, 1, 'the server must not choose between a root database and a platform');
    assert.equal(result.stdout.trim(), '', 'a refused startup does not print a readiness line');
    assert.match(result.stderr, /0\.2\.0 layout/, `the error names the unsupported layout: ${result.stderr}`);
    assert.ok(result.stderr.includes('platforms/'), `the error points at platforms/: ${result.stderr}`);
    assert.ok(result.stderr.includes('pigroups.db'), `the error names the files to move: ${result.stderr}`);
    assert.ok(existsSync(rootDb), 'the refused startup leaves the root database alone');
    assert.ok(existsSync(`${rootDb}-wal`), 'the refused startup leaves the root WAL alone');
    assert.deepEqual(await platformDirs(dataRoot), [platformId], 'the refused startup does not create another platform');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('two processes starting on an empty root agree on exactly one platform', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-race-'));
  const started: Server[] = [];
  try {
    const platformId = 'p_race0001';
    const outcomes = await Promise.allSettled([
      startServer({ dataDir: dataRoot, platformId }),
      startServer({ dataDir: dataRoot, platformId }),
    ]);
    // Partition before asserting: a thrown assertion here must not strand the
    // winner that a later outcome would have pushed into `started`.
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') started.push(outcome.value);
    }
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [String(outcome.reason)] : [],
    );
    for (const text of failures) {
      assert.match(text, /exited \(code=2/, `the first-start loser exits 2: ${text}`);
      assert.doesNotMatch(text, /listening on/, `the loser never became ready: ${text}`);
    }
    assert.equal(started.length, 1, 'exactly one process starts; the other is refused');

    const reported = new Set<string>();
    for (const server of started) reported.add(String((await health(server)).platform_id));
    assert.equal(reported.size, 1, 'every process that started reports the same platform');
    assert.deepEqual(await platformDirs(dataRoot), [...reported], 'the empty root holds exactly one platform');
  } finally {
    for (const server of started) await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('three simultaneous starts of one recorded platform leave exactly one serving', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-race-recorded-'));
  let first: Server | undefined;
  const started: Server[] = [];
  try {
    // A recorded platform: every starter reads the same port from the record, so
    // the bind — not the startup lock — decides between them.
    first = await startServer({ dataDir: dataRoot });
    const identity = String((await health(first)).platform_id);
    const recordedPort = first.port;
    await first.stop();
    first = undefined;

    const outcomes = await Promise.allSettled([
      startServer({ dataDir: dataRoot, platformId: identity }),
      startServer({ dataDir: dataRoot, platformId: identity }),
      startServer({ dataDir: dataRoot, platformId: identity }),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') started.push(outcome.value);
    }
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [String(outcome.reason)] : [],
    );
    for (const text of failures) {
      assert.match(text, /exited \(code=2/, `a loser exits 2: ${text}`);
      assert.match(text, /duplicate:/, `a loser names the duplicate: ${text}`);
      assert.doesNotMatch(text, /listening on/, `a loser never became ready: ${text}`);
    }

    assert.equal(started.length, 1, 'exactly one of three starters serves the platform');
    const winner = started[0];
    assert.equal(winner.port, recordedPort, 'the winner met the others on the recorded port');
    assert.equal(String((await health(winner)).platform_id), identity, 'the same platform came back');
    const record = readEndpointRecord(dataRoot, identity);
    assert.equal(record.port, winner.port, 'the record names the winning port');
    assert.equal(record.pid, winner.pid, 'the record names the winning process');
    assert.deepEqual(await platformDirs(dataRoot), [identity], 'no loser created a second platform');
    assert.equal(winner.stdout().split('\n').filter((line) => line.startsWith('listening on')).length, 1);
  } finally {
    if (first) await first.stop();
    for (const server of started) await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('two simultaneous first starts of one explicit id admit exactly one process', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-race-first-'));
  const platformId = 'p_0eee0001';
  const started: Server[] = [];
  try {
    // No endpoint record yet: the `wx` claim publishes the first seed, and the
    // loser follows that same candidate instead of binding its own port.
    const outcomes = await Promise.allSettled([
      startServer({ dataDir: dataRoot, platformId }),
      startServer({ dataDir: dataRoot, platformId }),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') started.push(outcome.value);
    }
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [String(outcome.reason)] : [],
    );
    for (const text of failures) {
      assert.match(text, /exited \(code=2/, `the first-start loser exits 2: ${text}`);
      assert.doesNotMatch(text, /listening on/, `the loser never became ready: ${text}`);
    }

    assert.equal(started.length, 1, 'exactly one process serves the first start');
    assert.equal(String((await health(started[0])).platform_id), platformId, 'the declared id is the one served');
    const record = readEndpointRecord(dataRoot, platformId);
    assert.equal(record.pid, started[0].pid, 'the record names the winning process');
    assert.equal(record.port, started[0].port, 'the record names the winning port');
  } finally {
    for (const server of started) await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a start walks past several occupied ports to the first free one', async (t) => {
  const held = await holdHttpPort();
  const next = await holdHttpAt(held.port + 1);
  if (next === undefined) {
    await held.release();
    t.skip('the port above the first holder was not available to the test');
    return;
  }
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-walk-'));
  let server: Server | undefined;
  try {
    server = await startServer({ dataDir: dataRoot, seedPort: held.port });
    assert.ok(server.port >= held.port + 2, `served on ${server.port}, past ${held.port} and ${held.port + 1}`);
    assert.equal(server.stderr(), '', 'walking past two unrelated services is not an error');
    const identity = String((await health(server)).platform_id);
    const record = readEndpointRecord(dataRoot, identity);
    assert.equal(record.port, server.port, 'the record names the port the walk ended on');
    assert.equal(record.pid, server.pid, 'the record names the process that bound it');
  } finally {
    if (server) await server.stop();
    await next.release();
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('directories without pigroups.db are not platforms and do not block single-platform reuse', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-dead-dirs-'));
  const liveId = 'p_0000aaaa';
  let server: Server | undefined;
  try {
    const live = await startServer({ dataDir: dataRoot, platformId: liveId });
    await live.stop();

    const deadDir = join(dataRoot, 'platforms', 'p_dead0001');
    mkdirSync(deadDir, { recursive: true });
    writeFileSync(join(deadDir, 'server.log'), 'a failed 0.3.0 start\n');
    mkdirSync(join(dataRoot, 'platforms', 'p_empty001'), { recursive: true });

    server = await startServer({ dataDir: dataRoot });
    assert.equal(String((await health(server)).platform_id), liveId, 'the only real platform is reused');
  } finally {
    if (server) await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a root with only a platform-shaped empty directory gets a fresh platform, not that directory', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-dead-only-'));
  const deadId = 'p_dead0002';
  let server: Server | undefined;
  try {
    const deadDir = join(dataRoot, 'platforms', deadId);
    mkdirSync(deadDir, { recursive: true });
    writeFileSync(join(deadDir, 'server.log'), 'a failed 0.3.0 start\n');

    server = await startServer({ dataDir: dataRoot });
    const platformId = String((await health(server)).platform_id);
    assert.match(platformId, /^p_[0-9a-f]{8}$/, 'a fresh platform is created');
    assert.notEqual(platformId, deadId, 'the empty directory is not mistaken for a platform');
    assert.ok(existsSync(databasePath(dataRoot, platformId)), 'the new platform has a database');
    assert.equal(existsSync(databasePath(dataRoot, deadId)), false, 'the empty directory was not turned into a platform');
  } finally {
    if (server) await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('an old database at the root refuses to start even when PIGROUPS_PLATFORM_ID names an existing platform', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-adopt-explicit-conflict-'));
  const platformId = 'p_0000feed';
  const rootDb = join(dataRoot, 'pigroups.db');
  try {
    const existing = await startServer({ dataDir: dataRoot, platformId });
    await existing.stop();
    writeOldDatabase(rootDb);

    const result = await runToExit({ dataDir: dataRoot, platformId });
    assert.equal(result.code, 1, 'an unclaimed database at the root is never silently ignored');
    assert.match(result.stderr, /0\.2\.0 layout/, `the error names the unsupported layout: ${result.stderr}`);
    assert.ok(existsSync(rootDb), 'the refused startup leaves the root database in place');
    assert.deepEqual(await platformDirs(dataRoot), [platformId], 'the refused startup creates nothing');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a directory named pigroups.db is not a platform', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-db-dir-'));
  const impostor = 'p_dir00001';
  let server: Server | undefined;
  try {
    mkdirSync(join(dataRoot, 'platforms', impostor, 'pigroups.db'), { recursive: true });

    server = await startServer({ dataDir: dataRoot });
    const platformId = String((await health(server)).platform_id);
    assert.match(platformId, /^p_[0-9a-f]{8}$/, 'a fresh platform is created');
    assert.notEqual(platformId, impostor, 'a directory that happens to be named pigroups.db is not a platform');
    assert.ok(existsSync(databasePath(dataRoot, platformId)), 'the generated platform has a real database file');
  } finally {
    if (server) await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('renaming a platform directory refuses to start and asks for the directory to be renamed back', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-renamed-'));
  const renamedId = 'p_renamed99';
  let platformId = '';
  try {
    const server = await startServer({ dataDir: dataRoot });
    platformId = String((await health(server)).platform_id);
    await server.stop();
    await rename(join(dataRoot, 'platforms', platformId), join(dataRoot, 'platforms', renamedId));

    const result = await runToExit({ dataDir: dataRoot });
    assert.equal(result.code, 1, 'the stored identity wins over the directory name');
    assert.equal(result.stdout.trim(), '', 'a refused startup does not print a readiness line');
    assert.ok(result.stderr.includes(platformId), `the error names the stored id: ${result.stderr}`);
    assert.ok(result.stderr.includes(renamedId), `the error names the directory: ${result.stderr}`);
    assert.match(
      result.stderr,
      new RegExp(`rename the directory back to ${platformId}`, 'i'),
      `the error asks for the directory to be renamed back: ${result.stderr}`,
    );
    assert.doesNotMatch(
      result.stderr,
      /use the stored id/,
      'the advice must not be to start with the stored id, which would create a second, empty platform',
    );
    assert.deepEqual(await platformDirs(dataRoot), [renamedId], 'the refused startup creates nothing');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a seed port outside the valid range fails instead of walking', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-bad-port-'));
  try {
    const result = await runToExit({ dataDir: dataRoot, platformId: 'p_0bad0001', port: 99_999 });
    assert.equal(result.code, 1, 'an unusable port is a startup failure, not a reason to walk');
    assert.equal(result.stdout.trim(), '', 'no readiness line');
    assert.match(result.stderr, /cannot listen on 99999:/, result.stderr);
    assert.deepEqual(await platformDirs(dataRoot), [], 'the failed start removed the empty platform directory');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('readEndpoint ignores a record whose port is not a usable port', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-record-shape-'));
  const platformId = 'p_0bad0001';
  const dir = join(dataRoot, 'platforms', platformId);
  try {
    mkdirSync(dir, { recursive: true });
    for (const port of [0, 70_000, '80', 1.5, null]) {
      writeFileSync(
        endpointPath(dataRoot, platformId),
        JSON.stringify({ platform_id: platformId, port, version: '0.6.0', pid: 1, updated_at: 1 }),
      );
      assert.equal(readEndpoint(dir), null, `port ${JSON.stringify(port)} is not a usable port`);
    }

    writeFileSync(endpointPath(dataRoot, platformId), JSON.stringify([]));
    assert.equal(readEndpoint(dir), null, 'an array is not a record');

    // A record without a pid cannot identify a holder; it is not a valid
    // record, and the caller must fail closed rather than treat it as a hint.
    writeFileSync(
      endpointPath(dataRoot, platformId),
      JSON.stringify({ platform_id: platformId, port: 7717, version: '0.6.0', updated_at: 1 }),
    );
    assert.equal(readEndpoint(dir), null, 'a record without a pid is not usable');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a startup that meets a platform blocked opening its database exits 2 from the record', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-blocked-open-'));
  const platformId = 'p_0b100001';
  let first: Server | undefined;
  let raw: ReturnType<typeof spawnRaw> | undefined;
  let locker: DatabaseSync | undefined;
  try {
    first = await startServer({ dataDir: dataRoot, platformId });
    await first.stop();
    first = undefined;

    const dbPath = databasePath(dataRoot, platformId);
    const seed = await freePortNumber();

    // Hold the write lock: the platform binds and writes its record, then blocks
    // in `openDatabase`. That is exactly the window the record exists for.
    locker = new DatabaseSync(dbPath, { timeout: 5_000 });
    locker.exec('BEGIN IMMEDIATE');
    locker.prepare("INSERT INTO meta (key, value) VALUES ('blocker', '1')").run();

    raw = spawnRaw({ dataDir: dataRoot, platformId, seedPort: seed });
    const deadline = Date.now() + 5_000;
    let record = readEndpoint(join(dataRoot, 'platforms', platformId));
    while (record === null || record.pid !== raw.pid || !(await isListening(record.port))) {
      if (Date.now() >= deadline) throw new Error(`no bound endpoint record for the blocked platform\n${raw.stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      record = readEndpoint(join(dataRoot, 'platforms', platformId));
    }

    const probe = await fetch(`http://127.0.0.1:${record.port}/v1/health`, {
      signal: AbortSignal.timeout(300),
    }).then(
      () => 'answered',
      () => 'timed out',
    );
    assert.equal(probe, 'timed out', 'the synchronous database open blocks the event loop');

    const competitor = await runToExit({ dataDir: dataRoot, platformId, port: seed });
    assert.equal(competitor.code, 2, `the record, not the probe, identifies the holder: ${competitor.stderr}`);
    assert.match(competitor.stderr, /duplicate:/, competitor.stderr);
    assert.equal(readEndpoint(join(dataRoot, 'platforms', platformId))?.pid, raw.pid, 'the competitor did not rewrite the record');

    locker.exec('ROLLBACK');
    locker.close();
    locker = undefined;

    const ready = Date.now() + 10_000;
    for (;;) {
      const answer = await fetch(`http://127.0.0.1:${record.port}/v1/health`).catch(() => undefined);
      if (answer !== undefined && answer.status === 200) {
        const body = (await answer.json()) as { status?: string; platform_id?: string };
        assert.equal(body.status, 'ok', 'the blocked platform becomes ready after the lock is released');
        assert.equal(body.platform_id, platformId);
        break;
      }
      if (Date.now() >= ready) throw new Error(`the blocked platform never became ready\n${raw.stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.match(raw.stdout(), /listening on/, 'the blocked platform printed its readiness line');
    raw.kill('SIGTERM');
  } finally {
    try {
      locker?.exec('ROLLBACK');
    } catch {
      // already rolled back
    }
    try {
      locker?.close();
    } catch {
      // already closed
    }
    raw?.kill('SIGKILL');
    if (first) await first.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a seed port held by an unrelated HTTP service moves the platform to the next port and records it', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-listen-'));
  const held = await holdHttpPort();
  let server: Server | undefined;
  try {
    server = await startServer({ dataDir: dataRoot, seedPort: held.port });
    assert.ok(server.port > held.port, `the platform moved past ${held.port}, bound ${server.port}`);
    assert.equal(server.stderr(), '', 'advancing past an unrelated service is not an error');

    const identity = String((await health(server)).platform_id);
    const record = readEndpointRecord(dataRoot, identity);
    assert.equal(record.platform_id, identity, 'the endpoint names the platform');
    assert.equal(record.port, server.port, 'the endpoint names the port the platform actually bound');
    assert.equal(record.pid, server.pid, 'the endpoint names the process that bound it');
    assert.equal(record.version, (await health(server)).version, 'the endpoint carries the server version');

    // A restart meets the platform on its recorded port, not on the seed again.
    const recorded = server.port;
    await server.stop();
    server = undefined;
    const restarted = await startServer({ dataDir: dataRoot });
    try {
      assert.equal(restarted.port, recorded, 'the recorded port is the rendezvous for the next start');
      assert.equal(String((await health(restarted)).platform_id), identity, 'the same platform came back');
    } finally {
      await restarted.stop();
    }
  } finally {
    if (server) await server.stop();
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a second start of the same platform exits 2 and leaves the first one serving', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-duplicate-'));
  let server: Server | undefined;
  try {
    server = await startServer({ dataDir: dataRoot });
    const identity = String((await health(server)).platform_id);
    const before = readEndpointRecord(dataRoot, identity);
    const databaseBefore = readFileSync(databasePath(dataRoot, identity));
    const logPath = join(dataRoot, 'platforms', identity, 'server.log');
    const logLinesBefore = readFileSync(logPath, 'utf8').split('\n').filter((line) => line !== '').length;

    const result = await runToExit({ dataDir: dataRoot, port: server.port });
    assert.equal(result.code, 2, `a duplicate start exits 2: ${result.stderr}`);
    assert.equal(result.stdout.trim(), '', 'a duplicate start prints no readiness line');
    assert.match(result.stderr, /platform .* is already bound/, result.stderr);
    assert.match(result.stderr, /duplicate:/, result.stderr);
    assert.equal(
      result.stderr.split('\n').some((line) => /^\s+at\s/.test(line)),
      false,
      `stderr carries no stack frames: ${result.stderr}`,
    );

    assert.ok((await health(server)).status === 'ok', 'the original platform is untouched');
    assert.deepEqual(readEndpointRecord(dataRoot, identity), before, 'the duplicate wrote nothing');
    assert.ok(
      readFileSync(databasePath(dataRoot, identity)).equals(databaseBefore),
      'the duplicate never opened the database',
    );
    assert.deepEqual(await platformDirs(dataRoot), [identity], 'no second platform directory appeared');
    assert.equal(
      readFileSync(logPath, 'utf8').split('\n').filter((line) => line !== '').length,
      logLinesBefore,
      'a duplicate writes no readiness line to server.log',
    );
  } finally {
    if (server) await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a port held by something that never answers is left after both probes', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-silent-'));
  const held = await holdPort();
  let server: Server | undefined;
  try {
    // No probe names this platform and there is no record, so after both probes
    // the candidate is "not us" and the start moves on (design §11.0).
    server = await startServer({ dataDir: dataRoot, seedPort: held.port });
    assert.ok(server.port > held.port, `served on ${server.port}, past the silent ${held.port}`);
    assert.equal(server.stderr(), '', 'moving past a silent holder is not an error');
    assert.equal(readEndpointRecord(dataRoot, String((await health(server)).platform_id)).port, server.port);
  } finally {
    if (server) await server.stop();
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a port recorded as this platform exits 2 even when it cannot answer', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-recorded-silent-'));
  const platformId = 'p_0ddd0001';
  const held = await holdPort();
  try {
    mkdirSync(join(dataRoot, 'platforms', platformId), { recursive: true });
    writeFileSync(
      endpointPath(dataRoot, platformId),
      JSON.stringify({
        platform_id: platformId,
        port: held.port,
        version: '0.6.0',
        pid: process.pid,
        updated_at: Date.now(),
      }),
    );

    const result = await runToExit({ dataDir: dataRoot, port: held.port, platformId });
    assert.equal(result.code, 2, `the record is the same positive fact the probe would return: ${result.stderr}`);
    assert.equal(result.stdout.trim(), '', 'no readiness line');
    assert.match(result.stderr, /duplicate: platform p_0ddd0001 is already bound/, result.stderr);
    assert.equal(existsSync(join(dataRoot, 'platforms', platformId, 'pigroups.db')), false, 'the duplicate opened nothing');
  } finally {
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a bind error that is not EADDRINUSE fails without leaving an empty platform directory', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('port 1 is bindable as root, so this host cannot produce EACCES');
    return;
  }
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-eacces-'));
  try {
    const result = await runToExit({ dataDir: dataRoot, platformId: 'p_0eac0001', port: 1 });
    assert.equal(result.code, 1, 'a bind error is a startup failure');
    assert.equal(result.stdout.trim(), '', 'no readiness line');
    assert.match(result.stderr, /cannot listen on 1:/, result.stderr);
    assert.deepEqual(await platformDirs(dataRoot), [], 'the failed start removed the empty platform directory');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('the endpoint record is written before the database is opened', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-order-'));
  const platformId = 'p_0abc0001';
  let locker: DatabaseSync | undefined;
  let raw: ReturnType<typeof spawnRaw> | undefined;
  try {
    const first = await startServer({ dataDir: dataRoot, platformId });
    await first.stop();

    locker = new DatabaseSync(databasePath(dataRoot, platformId), { timeout: 5_000 });
    locker.exec('BEGIN IMMEDIATE');
    const seed = await freePortNumber();
    raw = spawnRaw({ dataDir: dataRoot, platformId, seedPort: seed });

    const deadline = Date.now() + 5_000;
    let record = readEndpoint(join(dataRoot, 'platforms', platformId));
    while (record === null || record.pid !== raw.pid || !(await isListening(record.port))) {
      if (Date.now() >= deadline) throw new Error(`no bound endpoint record\n${raw.stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      record = readEndpoint(join(dataRoot, 'platforms', platformId));
    }

    assert.deepEqual(
      Object.keys(record).sort(),
      ['pid', 'platform_id', 'port', 'updated_at', 'version'],
      'the record has exactly the documented keys',
    );
    assert.equal(record.platform_id, platformId);
    assert.equal(record.pid, raw.pid, 'the record names the process that bound it');
    assert.equal(typeof record.version, 'string');
    assert.ok(Math.abs(Date.now() - record.updated_at) < 60_000, 'updated_at is a recent Unix ms');
    assert.equal(
      statSync(endpointPath(dataRoot, platformId)).mode & 0o777,
      0o600,
      'the endpoint record is 0600',
    );
    assert.deepEqual(
      readdirSync(join(dataRoot, 'platforms', platformId)).filter((name) => name.includes('.tmp')),
      [],
      'the atomic write left no temp file',
    );
  } finally {
    try {
      locker?.exec('ROLLBACK');
    } catch {
      // already rolled back
    }
    try {
      locker?.close();
    } catch {
      // already closed
    }
    raw?.kill('SIGKILL');
    await rm(dataRoot, { recursive: true, force: true });
  }
});
test('SIGKILL leaves the record, and the next start reuses its port and data', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-sigkill-'));
  let server: Server | undefined;
  let restarted: Server | undefined;
  try {
    server = await startServer({ dataDir: dataRoot });
    const identity = String((await health(server)).platform_id);
    const root = await bootstrapRoot(server);
    const port = server.port;
    const pid = server.pid;
    const before = readEndpointRecord(dataRoot, identity);

    const exit = await server.crash();
    server = undefined;
    assert.equal(exit.signal, 'SIGKILL', 'the process was killed, not asked to leave');
    assert.equal(readEndpointRecord(dataRoot, identity).pid, pid, 'the dead pid is still recorded');

    restarted = await startServer({ dataDir: dataRoot });
    assert.equal(restarted.port, port, 'the restart met the record on the same port');
    assert.equal(String((await health(restarted)).platform_id), identity, 'the same platform came back');

    const who = await call(restarted, 'GET', '/v1/whoami', { token: root.token });
    assertOk(who, 'GET /v1/whoami after a SIGKILL restart');
    assert.equal(who.body.member.id, root.id, 'the root token still names the same member');

    const after = readEndpointRecord(dataRoot, identity);
    assert.equal(after.pid, restarted.pid, 'the record names the new process');
    assert.ok(after.updated_at >= before.updated_at, 'updated_at moved forward');
    assert.deepEqual(await platformDirs(dataRoot), [identity], 'still exactly one platform');
  } finally {
    if (server) await server.stop();
    if (restarted) await restarted.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a positive platform_id on the second probe alone exits 2', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-second-probe-'));
  const platformId = 'p_0fff0001';
  const held = await holdScriptedHealth([
    { body: { hello: 'not a pigroups platform' } },
    { body: { status: 'starting', version: '0.0.0', platform_id: platformId } },
  ]);
  try {
    const result = await runToExit({ dataDir: dataRoot, platformId, port: held.port });
    assert.equal(result.code, 2, `the second probe is enough: ${result.stderr}`);
    assert.equal(result.stdout.trim(), '', 'no readiness line');
    assert.match(result.stderr, /duplicate:/, result.stderr);
    assert.match(result.stderr, /status starting/, `the answer that ended the start is named: ${result.stderr}`);

    const requests = held.requests();
    assert.equal(requests.length, 2, 'exactly the two probes, no third');
    assert.ok(requests[1].at - requests[0].at >= 140, 'the probes are separated by the documented pause');
    const claim = readEndpoint(join(dataRoot, 'platforms', platformId));
    assert.equal(claim?.port, held.port, 'the first-start claim names the contested port');
    assert.equal(claim?.pid, result.pid, 'the claim names the process that made it');
    assert.equal(existsSync(databasePath(dataRoot, platformId)), false, 'a duplicate opens no database');
  } finally {
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a holder that names a different platform on both probes is walked past', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-other-id-'));
  const held = await holdScriptedHealth([
    { body: { status: 'ok', version: '0.0.0', platform_id: 'p_other001' } },
    { body: { status: 'ok', version: '0.0.0', platform_id: 'p_other001' } },
  ]);
  let server: Server | undefined;
  try {
    server = await startServer({ dataDir: dataRoot, platformId: 'p_mine0001', seedPort: held.port });
    assert.ok(server.port > held.port, `served on ${server.port}, past the other platform`);
    assert.equal(String((await health(server)).platform_id), 'p_mine0001', 'our platform is the one served');
    assert.equal(server.stderr(), '', 'another platform is not an error');
    assert.equal(held.requests().length, 2, 'two probes before moving on');
    assert.equal(readEndpointRecord(dataRoot, 'p_mine0001').port, server.port, 'the record names our port');
  } finally {
    if (server) await server.stop();
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a matching record with a live pid wins even when the port answers as another service', async () => {
  // This pins the residual risk §11.0 accepts: the record is the only witness
  // while the platform is blocked opening its database. It is not a bug.
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-record-risk-'));
  const platformId = 'p_0aaa0002';
  const held = await holdHttpPort();
  try {
    mkdirSync(join(dataRoot, 'platforms', platformId), { recursive: true });
    writeFileSync(
      endpointPath(dataRoot, platformId),
      JSON.stringify({
        platform_id: platformId,
        port: held.port,
        version: '0.6.0',
        pid: process.pid,
        updated_at: Date.now(),
      }),
    );
    const before = readFileSync(endpointPath(dataRoot, platformId));

    const result = await runToExit({ dataDir: dataRoot, platformId, port: held.port });
    assert.equal(result.code, 2, `the record is the same positive fact: ${result.stderr}`);
    assert.match(result.stderr, /duplicate:/, result.stderr);
    assert.ok(
      readFileSync(endpointPath(dataRoot, platformId)).equals(before),
      'the duplicate did not rewrite the record',
    );
    assert.equal(existsSync(databasePath(dataRoot, platformId)), false, 'the duplicate opened no database');
  } finally {
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a record whose pid is dead is ignored and the start advances', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-record-dead-'));
  const platformId = 'p_0dead001';
  const held = await holdPort();
  let server: Server | undefined;
  try {
    mkdirSync(join(dataRoot, 'platforms', platformId), { recursive: true });
    writeFileSync(
      endpointPath(dataRoot, platformId),
      JSON.stringify({
        platform_id: platformId,
        port: held.port,
        version: '0.6.0',
        pid: deadPid(),
        updated_at: Date.now(),
      }),
    );

    server = await startServer({ dataDir: dataRoot, platformId, seedPort: held.port });
    assert.ok(server.port > held.port, `served on ${server.port}, past the dead record`);
    const record = readEndpointRecord(dataRoot, platformId);
    assert.equal(record.port, server.port, 'the record was rewritten with the new port');
    assert.equal(record.pid, server.pid, 'the record names the live process');
  } finally {
    if (server) await server.stop();
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('two established platforms in one data root start at the same time', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-two-'));
  const first = 'p_aaaaaaa1';
  const second = 'p_bbbbbbb2';
  const started: Server[] = [];
  try {
    for (const id of [first, second]) {
      const one = await startServer({ dataDir: dataRoot, platformId: id });
      await one.stop();
    }

    const outcomes = await Promise.allSettled([
      startServer({ dataDir: dataRoot, platformId: first }),
      startServer({ dataDir: dataRoot, platformId: second }),
    ]);
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'fulfilled', `both platforms start: ${String((outcome as PromiseRejectedResult).reason ?? '')}`);
      if (outcome.status === 'fulfilled') started.push(outcome.value);
    }

    const ids = new Set<string>();
    for (const server of started) ids.add(String((await health(server)).platform_id));
    assert.deepEqual([...ids].sort(), [first, second], 'each server reports its own platform');
    assert.notEqual(started[0].port, started[1].port, 'they do not share a port');
    assert.deepEqual((await platformDirs(dataRoot)).sort(), [first, second]);
  } finally {
    for (const server of started) await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a holder that only listens on ::1 is left after both probes', async (t) => {
  const held = await holdAddress('::1').catch(() => undefined);
  if (held === undefined) {
    t.skip('this host does not have a usable ::1');
    return;
  }
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-v6-'));
  let server: Server | undefined;
  try {
    // The probe is hard-coded to 127.0.0.1, so an IPv6-only holder is "no
    // answer" — the documented limit of an IPv4 loopback probe.
    server = await startServer({ dataDir: dataRoot, seedPort: held.port });
    assert.ok(server.port > held.port, `served on ${server.port}, past the ::1 holder`);
    assert.equal(server.stderr(), '', 'an unreachable holder is not an error');
  } finally {
    if (server) await server.stop();
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('an endpoint record naming another platform refuses to start', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-endpoint-foreign-'));
  const foreign = 'p_00000000';
  let first: Server | undefined;
  try {
    first = await startServer({ dataDir: dataRoot });
    const identity = String((await health(first)).platform_id);
    await first.stop();
    first = undefined;

    writeFileSync(
      endpointPath(dataRoot, identity),
      JSON.stringify({
        platform_id: foreign,
        port: await freePortNumber(),
        version: '0.0.0',
        pid: process.pid,
        updated_at: Date.now(),
      }),
    );

    const result = await runToExit({ dataDir: dataRoot });
    assert.equal(result.code, 1, 'a foreign record is not followed');
    assert.equal(result.stdout.trim(), '', 'no readiness line');
    assert.match(result.stderr, new RegExp(`names platform ${foreign}`), result.stderr);
    assert.match(result.stderr, new RegExp(identity), `the error names the directory id: ${result.stderr}`);
    assert.match(result.stderr, /rename the directory back/i, result.stderr);
    assert.equal(readEndpointRecord(dataRoot, identity).platform_id, foreign, 'the record is not rewritten');
    assert.ok(existsSync(databasePath(dataRoot, identity)), 'the database is untouched');
  } finally {
    if (first) await first.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
test('a malformed endpoint record refuses to start', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-endpoint-broken-'));
  let first: Server | undefined;
  try {
    first = await startServer({ dataDir: dataRoot });
    const identity = String((await health(first)).platform_id);
    await first.stop();
    first = undefined;

    writeFileSync(endpointPath(dataRoot, identity), '{not json');
    const result = await runToExit({ dataDir: dataRoot });
    assert.equal(result.code, 1, 'an unreadable record is not ignored');
    assert.equal(result.stdout.trim(), '', 'no readiness line');
    assert.match(result.stderr, /not a readable endpoint record/, result.stderr);
    assert.match(result.stderr, /Remove it by hand/, result.stderr);
    assert.equal(readFileSync(endpointPath(dataRoot, identity), 'utf8'), '{not json', 'the record is not unlinked');
    assert.ok(existsSync(databasePath(dataRoot, identity)), 'the database is untouched');
  } finally {
    if (first) await first.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
test('the last candidate port does not wrap around', async (t) => {
  const held = await holdHttpAt(65_535);
  if (held === undefined) {
    t.skip('this host does not let the test bind port 65535');
    return;
  }
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-overflow-'));
  try {
    const result = await runToExit({ dataDir: dataRoot, platformId: 'p_0fff0002', port: 65_535 });
    assert.equal(result.code, 1, 'there is no port above 65535 to advance to');
    assert.equal(result.stdout.trim(), '', 'no readiness line');
    assert.match(result.stderr, /cannot listen on any port from 65535 to 65535/, result.stderr);
  } finally {
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a holder that only listens on another loopback address is left after both probes', async (t) => {
  const held = await holdAddress('127.0.0.2').catch(() => undefined);
  if (held === undefined) {
    t.skip('this host does not have a second loopback address');
    return;
  }
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-unprobeable-'));
  let server: Server | undefined;
  try {
    // Nothing listens on 127.0.0.1, so neither probe names this platform: "not us".
    server = await startServer({ dataDir: dataRoot, seedPort: held.port });
    assert.ok(server.port > held.port, `served on ${server.port}, past the unreachable ${held.port}`);
    assert.equal(server.stderr(), '', 'an unreachable holder is not an error');
  } finally {
    if (server) await server.stop();
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('an explicit platform id without a record creates the endpoint claim, and a stray .start.lock is ignored', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-lock-explicit-'));
  const platformId = 'p_0aaa0001';
  let first: Server | undefined;
  let second: Server | undefined;
  try {
    first = await startServer({ dataDir: dataRoot, platformId });
    assert.equal(String((await health(first)).platform_id), platformId);
    assert.ok(existsSync(join(dataRoot, 'platforms', platformId, 'endpoint.json')), 'the endpoint claim exists');
    assert.equal(existsSync(join(dataRoot, 'platforms', '.start.lock')), false, 'the server creates no startup lock');
    await first.stop();
    first = undefined;

    writeFileSync(
      join(dataRoot, 'platforms', '.start.lock'),
      JSON.stringify({ pid: process.pid, at: Date.now() }),
    );
    second = await startServer({ dataDir: dataRoot, platformId });
    assert.equal(String((await health(second)).platform_id), platformId, 'a stray lock does not block');
    assert.ok(existsSync(join(dataRoot, 'platforms', '.start.lock')), 'the stray file is not part of startup');
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
test('a 0.2.0 root database without a platform is refused and left in place', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-legacy-root-'));
  const rootDb = join(dataRoot, 'pigroups.db');
  try {
    writeOldDatabase(rootDb);
    writeFileSync(`${rootDb}-wal`, 'old wal');

    const result = await runToExit({ dataDir: dataRoot });
    assert.equal(result.code, 1, 'the 0.2 layout is not adopted');
    assert.match(result.stderr, /0\.2\.0 layout/, result.stderr);
    assert.ok(existsSync(rootDb), 'the root database is left alone');
    assert.ok(existsSync(`${rootDb}-wal`), 'the root WAL is left alone');
    assert.deepEqual(await platformDirs(dataRoot), [], 'no platform directory is created');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a record-less first start claims the seed port before binding', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-seed-claim-'));
  const platformId = 'p_0c1a0001';
  const held = await holdPort();
  let raw: ReturnType<typeof spawnRaw> | undefined;
  try {
    raw = spawnRaw({ dataDir: dataRoot, platformId, seedPort: held.port });

    const deadline = Date.now() + 5_000;
    let record = readEndpoint(join(dataRoot, 'platforms', platformId));
    while (record === null || record.pid !== raw.pid) {
      if (Date.now() >= deadline) throw new Error(`no endpoint claim\n${raw.stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      record = readEndpoint(join(dataRoot, 'platforms', platformId));
    }
    assert.equal(record.platform_id, platformId);
    assert.equal(record.port, held.port, 'the claim names the seed before the bind');
    assert.equal(record.pid, raw.pid);

    const ready = Date.now() + 10_000;
    for (;;) {
      const current = readEndpoint(join(dataRoot, 'platforms', platformId));
      if (current !== null && current.port > held.port && (await isListening(current.port))) break;
      if (Date.now() >= ready) throw new Error(`the platform never advanced past the seed\n${raw.stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    raw.kill('SIGTERM');
  } finally {
    raw?.kill('SIGKILL');
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a failed start keeps an existing record port rendezvous', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-failed-existing-'));
  const platformId = 'p_0fa10001';
  try {
    mkdirSync(join(dataRoot, 'platforms', platformId), { recursive: true });
    writeFileSync(databasePath(dataRoot, platformId), 'not a sqlite database');
    const port = await freePortNumber();
    writeFileSync(
      endpointPath(dataRoot, platformId),
      JSON.stringify({
        platform_id: platformId,
        port,
        version: '0.6.0',
        pid: deadPid(),
        updated_at: Date.now(),
      }),
    );

    const result = await runToExit({ dataDir: dataRoot, platformId });
    assert.equal(result.code, 1, 'a database that cannot be opened is a startup failure');
    const after = readEndpointRecord(dataRoot, platformId);
    assert.equal(after.port, port, 'the port rendezvous survives');
    assert.equal(after.pid, result.pid, 'the failed process wrote the record after its bind');
    assert.ok(existsSync(endpointPath(dataRoot, platformId)), 'the existing record is not removed');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('an invalid PORT is ignored when a valid record exists', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-bad-seed-recorded-'));
  const platformId = 'p_0bad0002';
  let first: Server | undefined;
  let second: Server | undefined;
  try {
    first = await startServer({ dataDir: dataRoot, platformId });
    const port = first.port;
    await first.stop();
    first = undefined;

    second = await startServer({ dataDir: dataRoot, platformId, seedPort: 99_999 });
    assert.equal(second.port, port, 'the recorded port wins over an invalid seed');
    assert.equal(String((await health(second)).platform_id), platformId);
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('two first starters walk past an occupied seed together and leave one server', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-race-walk-'));
  const platformId = 'p_0c1a0002';
  const held = await holdPort();
  const started: Server[] = [];
  try {
    const outcomes = await Promise.allSettled([
      startServer({ dataDir: dataRoot, platformId, seedPort: held.port }),
      startServer({ dataDir: dataRoot, platformId, seedPort: held.port }),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') started.push(outcome.value);
    }
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [String(outcome.reason)] : [],
    );
    for (const text of failures) {
      assert.match(text, /exited \(code=2/, `the loser exits 2: ${text}`);
      assert.doesNotMatch(text, /listening on/, `the loser never became ready: ${text}`);
    }
    assert.equal(started.length, 1, 'exactly one process serves the platform');
    const winner = started[0];
    assert.ok(winner.port > held.port, `the winner advanced past ${held.port}`);
    const record = readEndpointRecord(dataRoot, platformId);
    assert.equal(record.port, winner.port, 'the record names the winning port');
    assert.equal(record.pid, winner.pid, 'the record names the winning process');
  } finally {
    for (const server of started) await server.stop();
    await held.release();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a startup binds its port, records the endpoint, and opens the database there', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-platforms-listen-ok-'));
  const server = await startServer({ dataDir: dataRoot });
  try {
    assert.equal(server.stdout().split('\n').filter((line) => line !== '').length, 1, 'exactly one stdout line');
    assert.equal(server.stdout().trim(), `listening on ${server.port}`, 'stdout carries the readiness line');
    assert.equal(server.stderr(), '', 'a healthy start writes nothing to stderr');

    const identity = String((await health(server)).platform_id);
    assert.ok(existsSync(databasePath(dataRoot, identity)), 'the database lives under the platform id');
    const record = readEndpointRecord(dataRoot, identity);
    assert.equal(record.port, server.port, 'the record names the bound port');
    assert.equal(record.pid, server.pid, 'the record names the bound process');
    const mode = statSync(endpointPath(dataRoot, identity)).mode & 0o777;
    assert.equal(mode, 0o600, `the endpoint record is private to its owner, got ${mode.toString(8)}`);
  } finally {
    await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
