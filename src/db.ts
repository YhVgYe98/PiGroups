import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
`;

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'pigroups.db'), { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
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
