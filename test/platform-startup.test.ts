/**
 * Startup behaviour of the CLI: the port check, the startup lock, the default
 * data root, and what a refused start leaves behind. Everything here spawns a
 * real process with its own temporary data root and port.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertOk,
  call,
  databasePath,
  metaRows,
  platformDirs,
  runToExit,
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

function stderrLines(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line !== '');
}

test('a database that cannot be opened removes the record it created and names the file', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-startup-lock-bad-db-'));
  const platformId = 'p_bad00001';
  const dbPath = databasePath(dataRoot, platformId);
  try {
    mkdirSync(join(dataRoot, 'platforms', platformId), { recursive: true });
    writeFileSync(dbPath, 'not a sqlite database');

    const result = await runToExit({ dataDir: dataRoot });
    assert.equal(result.code, 1, 'a database that is not a database refuses the start');
    assert.equal(result.stdout.trim(), '', 'a refused startup does not print a readiness line');
    const lines = stderrLines(result.stderr);
    assert.equal(lines.length, 1, `the failure is one line, got: ${result.stderr}`);
    assert.match(lines[0], /^\[pigroups\] /, lines[0]);
    assert.ok(lines[0].includes(dbPath), `the message names the file that could not be opened: ${lines[0]}`);
    assert.equal(readFileSync(dbPath, 'utf8'), 'not a sqlite database', 'the failed open did not rewrite the file');
    assert.equal(
      existsSync(join(dataRoot, 'platforms', platformId, 'endpoint.json')),
      false,
      'the failed start removed the record it created',
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a zero-byte pigroups.db is a legal empty database and becomes the platform', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-startup-zero-db-'));
  const platformId = 'p_zero0001';
  const dbPath = databasePath(dataRoot, platformId);
  let server: Server | undefined;
  try {
    mkdirSync(join(dataRoot, 'platforms', platformId), { recursive: true });
    writeFileSync(dbPath, '');

    server = await startServer({ dataDir: dataRoot });
    assert.equal(String((await health(server)).platform_id), platformId, 'an empty file is the one existing platform');
    await server.stop();
    server = undefined;

    assert.deepEqual(
      Object.keys(metaRows(dbPath)).sort(),
      ['created_at', 'platform_id', 'server_version'],
      'the empty database got the three meta rows and nothing else',
    );
  } finally {
    if (server) await server.stop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a data root several levels deep is created on demand', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pigroups-startup-deep-root-'));
  const dataRoot = join(base, 'a', 'b', 'c');
  let server: Server | undefined;
  try {
    server = await startServer({ dataDir: dataRoot, createDataDir: false });
    const platformId = String((await health(server)).platform_id);
    assert.ok(existsSync(databasePath(dataRoot, platformId)), 'the whole path was created for the database');
  } finally {
    if (server) await server.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('without PIGROUPS_DATA the data root is ./.pigroups under the working directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pigroups-startup-default-root-'));
  let server: Server | undefined;
  try {
    server = await startServer({ cwd, omitDataDir: true });
    const platformId = String((await health(server)).platform_id);
    assert.ok(
      existsSync(join(cwd, '.pigroups', 'platforms', platformId, 'pigroups.db')),
      'the default data root is ./.pigroups',
    );
    assert.equal(existsSync(join(cwd, '.data')), false, 'the 0.2.0 default root is not resurrected');
  } finally {
    if (server) await server.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('server.log records every start on its own line and is appended to', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-startup-log-'));
  const version = await packageVersion();
  try {
    const first = await startServer({ dataDir: dataRoot });
    const platformId = String((await health(first)).platform_id);
    const firstPort = first.port;
    await first.stop();

    const logPath = join(dataRoot, 'platforms', platformId, 'server.log');
    const firstLog = readFileSync(logPath, 'utf8');
    assert.match(
      firstLog,
      new RegExp(`^\\S+ listening on ${firstPort} \\(server ${version}, platform ${platformId}\\)\\n$`),
      `server.log carries the timestamp, port, server version and platform id: ${firstLog}`,
    );

    const second = await startServer({ dataDir: dataRoot });
    const secondPort = second.port;
    await second.stop();

    const lines = stderrLines(readFileSync(logPath, 'utf8'));
    assert.equal(lines.length, 2, 'a restart appends a line instead of truncating the log');
    assert.ok(lines[1].includes(`listening on ${secondPort}`), `the second line is the new start: ${lines[1]}`);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('SIGTERM exits 0 and closes the database', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-startup-sigterm-'));
  try {
    const server = await startServer({ dataDir: dataRoot });
    const platformId = String((await health(server)).platform_id);
    const exit = await server.stop();

    assert.equal(exit.code, 0, `SIGTERM exits 0, got ${JSON.stringify(exit)}`);
    assert.deepEqual(
      (await readdir(join(dataRoot, 'platforms', platformId))).sort(),
      ['endpoint.json', 'pigroups.db', 'server.log'],
      'a clean shutdown leaves no -wal/-shm, which is the only outside proof the connection was closed',
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('an empty data root without PIGROUPS_PLATFORM_ID refuses to start', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-startup-no-id-'));
  try {
    const result = await runToExit({ dataDir: dataRoot });
    assert.equal(result.code, 1, 'an unnamed empty root is refused');
    assert.match(result.stderr, /PIGROUPS_PLATFORM_ID/, result.stderr);
    assert.equal(result.stdout.trim(), '', 'a refused startup does not print a readiness line');
    assert.deepEqual(await platformDirs(dataRoot), [], 'no platform was created');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('PIGROUPS_PLATFORM_ID="" is treated as unset, so an empty root refuses', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-startup-env-empty-'));
  try {
    const result = await runToExit({ dataDir: dataRoot, platformId: '' });
    assert.equal(result.code, 1, 'an empty id does not select a platform');
    assert.match(result.stderr, /PIGROUPS_PLATFORM_ID/, result.stderr);
    assert.equal(result.stdout.trim(), '', 'a refused startup does not print a readiness line');
    assert.deepEqual(await platformDirs(dataRoot), [], 'no platform was created');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('PIGROUPS_PLATFORM_ID that is not a single directory name is refused', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'pigroups-startup-env-traversal-'));
  try {
    for (const requested of ['../escape', 'a/b', 'p_x/', '..']) {
      const result = await runToExit({ dataDir: dataRoot, platformId: requested });
      assert.equal(result.code, 1, `${JSON.stringify(requested)} must be refused`);
      assert.equal(result.stdout.trim(), '', `${JSON.stringify(requested)}: no readiness line`);
      assert.match(result.stderr, /must be a single directory name/, `${JSON.stringify(requested)}: ${result.stderr}`);
    }
    assert.equal(existsSync(join(dataRoot, 'escape')), false, 'nothing was written outside platforms/');
    assert.equal(existsSync(join(dataRoot, 'pigroups.db')), false, 'nothing was written at the data root');
    assert.deepEqual(await platformDirs(dataRoot), [], 'a refused id creates no platform directory');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
