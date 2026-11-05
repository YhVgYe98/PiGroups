import { mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_VERSION } from './version.ts';

const IDENTITY_MISMATCH = 'PlatformIdMismatch';

export interface OpenDatabaseOptions {
  /**
   * An explicit platform selected by the caller. It is written when the database
   * is created; on an existing database it must match `meta.platform_id`.
   */
  platformId?: string;
}

/**
 * The schema of `docs/设计说明.md` §4. There is no `groups` table (a group is a
 * query on `parent_id`) and no `conversations` table (a conversation id is a
 * pure function of its participants).
 */
const SCHEMA = `
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
  heartbeat_at  INTEGER,
  gone_at       INTEGER,
  gone_reason   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_member_name ON members(name);
CREATE UNIQUE INDEX IF NOT EXISTS ux_root ON members(is_root) WHERE is_root = 1;
CREATE UNIQUE INDEX IF NOT EXISTS ux_spawn_idem ON members(parent_id, request_id) WHERE request_id IS NOT NULL;
-- Token to subject lookup on every authenticated request (auth middleware). Not part of the identity model.
CREATE INDEX IF NOT EXISTS ix_member_token ON members(token_hash);

CREATE TABLE IF NOT EXISTS humans (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  token_hash    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
-- Token to subject lookup on every authenticated request (auth middleware). Not part of the identity model.
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

CREATE TABLE IF NOT EXISTS meta (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
`;


/**
 * Opens the SQLite file inside one platform directory. The directory itself is
 * chosen by `resolvePlatform`; this function only knows where the file lives.
 */
export function openDatabase(dataDir: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'pigroups.db');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { timeout: 5000 });
  } catch (error) {
    throw openFailure(error, dbPath);
  }

  // Identity is checked before anything is written: a refused open must not
  // leave a `-wal`, a schema, or a `meta` row in another platform's database.
  try {
    assertStoredIdentity(db, options.platformId, dataDir);
  } catch (error) {
    closeQuietly(db);
    throw error instanceof Error && error.name === IDENTITY_MISMATCH ? error : openFailure(error, dbPath);
  }

  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
    migrateMemberHeartbeat(db);
    writeMeta(db, options.platformId, dataDir);
    backfillControlTargets(db);
  } catch (error) {
    closeQuietly(db);
    throw openFailure(error, dbPath);
  }
  return db;
}

/**
 * `heartbeat_at` arrived in 0.5.0 (§9.1). `CREATE TABLE IF NOT EXISTS` leaves
 * an existing members table untouched, so an older file needs this one
 * idempotent `ALTER TABLE`. There is no migration framework and no
 * `schema_version`: the column's presence is the whole state.
 *
 * The check and the `ALTER` share one write transaction on purpose. Two
 * processes may open the same pre-0.5.0 file at once (an explicit
 * `PIGROUPS_PLATFORM_ID` skips the start lock), so both can see "no column".
 * Without the transaction the loser's `ALTER` fails with
 * `duplicate column name: heartbeat_at` and that start is refused; with it the
 * loser waits for the winner's commit, re-reads the table inside the lock, sees
 * the column, and becomes a no-op.
 */
function migrateMemberHeartbeat(db: DatabaseSync): void {
  tx(db, () => {
    const columns = db.prepare("PRAGMA table_info('members')").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'heartbeat_at')) return;
    db.exec('ALTER TABLE members ADD COLUMN heartbeat_at INTEGER');
  });
}

/** A bare `file is not a database` is useless inside a data root that holds several of them. */
function openFailure(error: unknown, dbPath: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`cannot open ${dbPath}: ${message}`);
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // The open failure is the error worth reporting.
  }
}

/**
 * `platform_id` is written once, when the database is created; afterwards the
 * stored value wins. An explicit request for a different id means the caller
 * opened another platform's database, so it is a conflict rather than a rename.
 *
 * The remedy in the message is deliberate: starting with the stored id on the
 * renamed directory would create a *new* platform next to the old one and turn
 * the data root into an ambiguous one, hiding the real data for good.
 */
function assertStoredIdentity(
  db: DatabaseSync,
  requestedPlatformId: string | undefined,
  dataDir: string,
): void {
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get() as { name: string } | undefined;
  if (hasMeta === undefined) return;

  const stored = db.prepare("SELECT value FROM meta WHERE key = 'platform_id'").get() as
    | { value: string }
    | undefined;
  if (stored === undefined) return;
  if (requestedPlatformId === undefined || requestedPlatformId === stored.value) return;

  const directoryName = basename(resolve(dataDir));
  const mismatch = new Error(
    `platform id mismatch: the directory name is ${directoryName}, the database stores ${stored.value}; ` +
      'the database identity wins and they must match. ' +
      'An existing database is never renamed: rename the directory back to ' +
      `${stored.value}, or use a different data directory.`,
  );
  mismatch.name = IDENTITY_MISMATCH;
  throw mismatch;
}

/**
 * `created_at` is written once, when the database is first opened. The observed
 * server version is overwritten on every open; it never drives logic.
 */
function writeMeta(db: DatabaseSync, requestedPlatformId: string | undefined, dataDir: string): void {
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'platform_id'").get() as
    | { value: string }
    | undefined;

  if (stored === undefined) {
    const platformId = requestedPlatformId ?? basename(resolve(dataDir));
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('platform_id', ?)").run(platformId);
  }

  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)").run(String(Date.now()));
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('server_version', ?)").run(SERVER_VERSION);
}

/**
 * Before e03af1a, `sys.terminated` wrote the target member id into `to_json` as a
 * bare string while every other control wrote JSON. The readers now tolerate that
 * (`routes/control.ts`), but `GET /v1/control?to=` compares `to_json` with the JSON
 * form, so a legacy row would silently vanish from that filter. Rewrite them once,
 * at open: idempotent (`json_valid` is 0 only for the non-JSON rows) and bounded by
 * the size of the legacy set.
 */
function backfillControlTargets(db: DatabaseSync): void {
  db.exec("UPDATE controls SET to_json = json_quote(to_json) WHERE json_valid(to_json) = 0");
}

/**
 * A single write transaction. The platform is one process with a synchronous
 * driver, so nothing can interleave inside `body`.
 */
export function tx<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // the transaction was already rolled back by SQLite
    }
    throw error;
  }
}
