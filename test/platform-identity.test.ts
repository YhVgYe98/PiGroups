/**
 * Unit layer: these tests call `openDatabase` directly instead of going through
 * the CLI, because `created_at` and the identity check are properties of the
 * open call and are not observable over HTTP.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/db.ts';

function metaOf(dataDir: string): Record<string, string> {
  const db = new DatabaseSync(join(dataDir, 'pigroups.db'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  } finally {
    db.close();
  }
}

test('moving a database to a new directory keeps the platform_id written at creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pigroups-platform-identity-move-'));
  const firstDir = join(root, 'p_aaaa0001');
  const secondDir = join(root, 'p_bbbb0002');
  try {
    openDatabase(firstDir).close();
    assert.equal(metaOf(firstDir).platform_id, 'p_aaaa0001', 'the fixture starts with its directory name');

    await rename(firstDir, secondDir);

    openDatabase(secondDir).close();

    const meta = metaOf(secondDir);
    assert.equal(meta.platform_id, 'p_aaaa0001', 'the database keeps the identity it was created with');
    assert.notEqual(meta.platform_id, basename(secondDir), 'the new directory name does not overwrite the identity');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('opening a database with a different explicit platform_id throws and names both ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pigroups-platform-identity-conflict-'));
  const dir = join(root, 'p_cccc0003');
  try {
    // A rollback-journal database, like a 0.2.0 one: switching it to WAL (which
    // would happen if the identity check ran after the PRAGMAs and the schema)
    // is visible in the file bytes.
    mkdirSync(dir, { recursive: true });
    const fixture = new DatabaseSync(join(dir, 'pigroups.db'), { timeout: 5000 });
    try {
      fixture.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      fixture.prepare("INSERT INTO meta (key, value) VALUES ('platform_id', 'p_stored01')").run();
    } finally {
      fixture.close();
    }
    const before = readFileSync(join(dir, 'pigroups.db'));

    assert.throws(
      () => openDatabase(dir, { platformId: 'p_other02' }),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'the failure is an Error');
        assert.match(error.message, /p_cccc0003/, `the message names the directory: ${error.message}`);
        assert.match(error.message, /p_stored01/, `the message names the stored id: ${error.message}`);
        assert.match(
          error.message,
          /directory name is p_cccc0003[^]*database stores p_stored01[^]*database identity wins/,
          `the message explains which identity wins: ${error.message}`,
        );
        return true;
      },
    );

    assert.equal(metaOf(dir).platform_id, 'p_stored01', 'a refused open does not rename the stored identity');
    assert.equal(
      readFileSync(join(dir, 'pigroups.db')).equals(before),
      true,
      'a refused open leaves the other platform database byte for byte unchanged',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('opening without an explicit platform_id keeps the stored identity and created_at', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pigroups-platform-identity-default-'));
  const dir = join(root, 'directory-with-another-name');
  try {
    openDatabase(dir, { platformId: 'p_stored03' }).close();
    const first = metaOf(dir);

    openDatabase(dir).close();
    const second = metaOf(dir);

    assert.equal(second.platform_id, 'p_stored03', 'the stored identity wins over the directory name');
    assert.equal(second.created_at, first.created_at, 'created_at is still written only once');
    const createdAt = Number(first.created_at);
    assert.equal(Number.isInteger(createdAt), true, `created_at is an integer, got ${first.created_at}`);
    assert.ok(createdAt > Date.parse('2020-01-01T00:00:00Z'), `created_at is Unix milliseconds, got ${first.created_at}`);
    assert.ok(
      Math.abs(Date.now() - createdAt) < 300_000,
      `created_at is Unix milliseconds close to now, got ${first.created_at}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('created_at is written once and is never refreshed by a later open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pigroups-platform-identity-created-at-'));
  const dir = join(root, 'p_aaaa0011');
  try {
    openDatabase(dir, { platformId: 'p_aaaa0011' }).close();

    // A sentinel (rather than a comparison with a fresh clock reading) is what
    // separates "written once" from "rewritten on every open": two opens in the
    // same millisecond would look identical either way.
    const db = new DatabaseSync(join(dir, 'pigroups.db'), { timeout: 5000 });
    try {
      db.prepare("UPDATE meta SET value = '12345' WHERE key = 'created_at'").run();
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    openDatabase(dir).close();
    assert.equal(metaOf(dir).created_at, '12345', 'created_at is never rewritten, not even to the current time');

    openDatabase(dir, { platformId: 'p_aaaa0011' }).close();
    assert.equal(metaOf(dir).created_at, '12345', 'an explicit id does not rewrite created_at either');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
