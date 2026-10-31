import type { DatabaseSync } from 'node:sqlite';

export type MemberStatus = 'alive' | 'gone';
export type SenderKind = 'member' | 'human';

export interface MemberRow {
  id: string;
  name: string;
  parent_id: string | null;
  is_root: number;
  status: MemberStatus;
  token_hash: string;
  request_id: string | null;
  created_at: number;
  last_seen_at: number | null;
  gone_at: number | null;
  gone_reason: string | null;
}

export interface HumanRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface ControlRow {
  seq: number;
  id: string;
  from_id: string;
  to_json: string;
  cmd: string;
  payload_json: string | null;
  reply_to: string | null;
  created_at: number;
}

export interface ReceiptRow {
  control_seq: number;
  to_id: string;
  state: 'pending' | 'delivered';
  delivered_at: number | null;
}

export interface MessageRow {
  conv_id: string;
  seq: number;
  sender_id: string;
  sender_kind: SenderKind;
  client_msg_id: string | null;
  body: string;
  meta_json: string | null;
  created_at: number;
}

export interface GroupRef {
  to: string;
  owner: string;
}

export interface DmRef {
  to: string;
  peer: string;
}

function rows<T>(value: Record<string, unknown>[]): T[] {
  return value as unknown as T[];
}

function row<T>(value: Record<string, unknown> | undefined): T | undefined {
  return value as unknown as T | undefined;
}

export function getMember(db: DatabaseSync, id: string): MemberRow | undefined {
  return row<MemberRow>(db.prepare('SELECT * FROM members WHERE id = ?').get(id));
}

export function getHuman(db: DatabaseSync, id: string): HumanRow | undefined {
  return row<HumanRow>(db.prepare('SELECT * FROM humans WHERE id = ?').get(id));
}

export function getMemberByToken(db: DatabaseSync, tokenHash: string): MemberRow | undefined {
  return row<MemberRow>(db.prepare('SELECT * FROM members WHERE token_hash = ?').get(tokenHash));
}

export function getHumanByToken(db: DatabaseSync, tokenHash: string): HumanRow | undefined {
  return row<HumanRow>(db.prepare('SELECT * FROM humans WHERE token_hash = ?').get(tokenHash));
}

export function getControlBySenderKey(db: DatabaseSync, fromId: string, id: string): ControlRow | undefined {
  return row<ControlRow>(db.prepare('SELECT * FROM controls WHERE from_id = ? AND id = ?').get(fromId, id));
}

export function receiptsFor(db: DatabaseSync, controlSeq: number): ReceiptRow[] {
  return rows<ReceiptRow>(
    db.prepare('SELECT * FROM control_receipts WHERE control_seq = ? ORDER BY to_id').all(controlSeq),
  );
}

export function senderName(db: DatabaseSync, senderId: string, senderKind: SenderKind): string {
  if (senderKind === 'human') {
    return getHuman(db, senderId)?.name ?? senderId;
  }
  return getMember(db, senderId)?.name ?? senderId;
}

export function isNameTaken(db: DatabaseSync, name: string): boolean {
  return db.prepare('SELECT 1 FROM members WHERE name = ?').get(name) !== undefined;
}

/** `children(m)`: direct children that are not `gone` (concept §4.2, design §3.3). */
export function liveChildren(db: DatabaseSync, memberId: string): MemberRow[] {
  return rows<MemberRow>(
    db.prepare("SELECT * FROM members WHERE parent_id = ? AND status = 'alive' ORDER BY created_at, id").all(memberId),
  );
}

export function hasLiveChildren(db: DatabaseSync, memberId: string): boolean {
  return (
    db.prepare("SELECT 1 FROM members WHERE parent_id = ? AND status = 'alive' LIMIT 1").get(memberId) !== undefined
  );
}

/** `群(o) = {o} ∪ children(o)`; empty when the group does not exist. */
export function groupMembers(db: DatabaseSync, ownerId: string): MemberRow[] {
  const owner = getMember(db, ownerId);
  if (!owner || owner.status !== 'alive') return [];
  const children = liveChildren(db, ownerId);
  if (children.length === 0) return [];
  return [owner, ...children];
}

/** Self plus every descendant along `parent_id`, `gone` included. */
export function subtreeIds(db: DatabaseSync, rootId: string): string[] {
  const found = rows<{ id: string }>(
    db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM members WHERE id = ?
           UNION ALL
           SELECT m.id FROM members m JOIN sub s ON m.parent_id = s.id
         ) SELECT id FROM sub`,
      )
      .all(rootId),
  );
  return found.map((r) => r.id);
}

/** Nodes of the subtree that are still `alive`, the deletion target set. */
export function aliveSubtreeIds(db: DatabaseSync, rootId: string): string[] {
  return subtreeIds(db, rootId).filter((id) => getMember(db, id)?.status === 'alive');
}

/** True when `targetId` sits inside the subtree rooted at `ancestorId`, self included. */
export function isInOwnSubtree(db: DatabaseSync, ancestorId: string, targetId: string): boolean {
  let cursor: string | null = targetId;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ancestorId) return true;
    seen.add(cursor);
    cursor = getMember(db, cursor)?.parent_id ?? null;
  }
  return false;
}

/**
 * Senders may reach targets they share a group with: parent, child, or
 * same-parent sibling (concept §7).
 */
export function sharesGroup(db: DatabaseSync, a: string, b: string): boolean {
  if (a === b) return true;
  const left = getMember(db, a);
  const right = getMember(db, b);
  if (!left || !right) return false;
  if (left.parent_id === b || right.parent_id === a) return true;
  return left.parent_id !== null && left.parent_id === right.parent_id;
}

export function dmConvId(a: string, b: string): string {
  return a < b ? `dm:${a}_${b}` : `dm:${b}_${a}`;
}

const DM_CONV = /^dm:([mh]_[0-9a-f]+)_([mh]_[0-9a-f]+)$/;

export function parseDmConv(convId: string): { a: string; b: string } | undefined {
  const match = DM_CONV.exec(convId);
  if (!match) return undefined;
  return { a: match[1], b: match[2] };
}

/** DMs this member takes part in, as conversation ids. */
export function dmConvIdsOf(db: DatabaseSync, memberId: string): string[] {
  const found = rows<{ conv_id: string }>(
    db
      .prepare(
        `SELECT conv_id FROM messages WHERE sender_id = ? AND conv_id LIKE 'dm:%'
         UNION
         SELECT conv_id FROM inbox WHERE member_id = ? AND conv_id LIKE 'dm:%'`,
      )
      .all(memberId, memberId),
  );
  return found.map((r) => r.conv_id).sort();
}

export function allDmConvIds(db: DatabaseSync): string[] {
  const found = rows<{ conv_id: string }>(
    db.prepare("SELECT DISTINCT conv_id FROM messages WHERE conv_id LIKE 'dm:%' ORDER BY conv_id").all(),
  );
  return found.map((r) => r.conv_id);
}

export function peerOf(convId: string, memberId: string): string | undefined {
  const parsed = parseDmConv(convId);
  if (!parsed) return undefined;
  return parsed.a === memberId ? parsed.b : parsed.a;
}

export function conversationLastSeq(db: DatabaseSync, convId: string): number {
  const found = row<{ last_seq: number }>(
    db.prepare('SELECT last_seq FROM conversation_seqs WHERE conv_id = ?').get(convId),
  );
  return found ? Number(found.last_seq) : 0;
}

export function conversationLastAt(db: DatabaseSync, convId: string): number | null {
  const found = row<{ at: number | null }>(
    db.prepare('SELECT MAX(created_at) AS at FROM messages WHERE conv_id = ?').get(convId),
  );
  return found && found.at !== null ? Number(found.at) : null;
}

/** The member's consumption pointer; 0 means "nothing consumed yet". */
export function memberCursor(db: DatabaseSync, memberId: string): number {
  const found = row<{ last_seq: number }>(
    db.prepare('SELECT last_seq FROM member_cursors WHERE member_id = ?').get(memberId),
  );
  return found ? Number(found.last_seq) : 0;
}

export function unreadCount(db: DatabaseSync, memberId: string, convId: string): number {
  const found = row<{ n: number }>(
    db
      .prepare('SELECT COUNT(*) AS n FROM inbox WHERE member_id = ? AND conv_id = ? AND seq > ?')
      .get(memberId, convId, memberCursor(db, memberId)),
  );
  return found ? Number(found.n) : 0;
}

export function pendingReceiptCount(db: DatabaseSync, memberId: string): number {
  const found = row<{ n: number }>(
    db.prepare("SELECT COUNT(*) AS n FROM control_receipts WHERE to_id = ? AND state = 'pending'").get(memberId),
  );
  return found ? Number(found.n) : 0;
}

export function mentionExists(db: DatabaseSync, convId: string, seq: number, memberId: string): boolean {
  return (
    db.prepare('SELECT 1 FROM mentions WHERE conv_id = ? AND msg_seq = ? AND member_id = ?').get(convId, seq, memberId) !==
    undefined
  );
}

export function mentionsOf(db: DatabaseSync, convId: string, seq: number): string[] {
  const found = rows<{ member_id: string }>(
    db.prepare('SELECT member_id FROM mentions WHERE conv_id = ? AND msg_seq = ? ORDER BY member_id').all(convId, seq),
  );
  return found.map((r) => r.member_id);
}

export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}
