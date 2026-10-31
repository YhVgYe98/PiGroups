import type { DatabaseSync } from 'node:sqlite';
import { tx } from './db.ts';
import {
  type ControlRow,
  getMember,
  mentionExists,
  memberCursor,
  pendingReceiptCount,
  senderName,
} from './store.ts';

export interface ControlItem {
  kind: 'control';
  control_seq: number;
  id: string;
  from_id: string;
  cmd: string;
  payload: unknown;
  reply_to: string | null;
  created_at: number;
}

export interface GapItem {
  kind: 'gap';
  to: string;
  count: number;
  before: number;
  mentioned: number;
}

export interface MessageItem {
  kind: 'message';
  to: string;
  seq: number;
  from_id: string;
  from_name: string;
  from_kind: string;
  preview: string;
  mentions_me: boolean;
  from_parent: boolean;
  at: number;
}

export type PollItem = ControlItem | GapItem | MessageItem;

export interface PollTypes {
  message: boolean;
  control: boolean;
}

export type ConsumeResult =
  | { gone: true }
  | { gone: false; items: PollItem[]; control_pending: number };

export interface PollHub {
  /** Members with a poll waiting right now; a second poll gets 409 (§6.6). */
  inflight: Set<string>;
  /** One wake callback per waiting member; a wake is not a delivery. */
  waiters: Map<string, () => void>;
}

export function createPollHub(): PollHub {
  return { inflight: new Set(), waiters: new Map() };
}

/** Anything that can make a waiting poll return: a delivery or a deletion. */
export function wakeMembers(hub: PollHub, memberIds: Iterable<string>): void {
  for (const id of memberIds) {
    const wake = hub.waiters.get(id);
    if (wake) wake();
  }
}

export function waitForWake(hub: PollHub, memberId: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      if (hub.waiters.get(memberId) === done) hub.waiters.delete(memberId);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, timeoutMs));
    hub.waiters.set(memberId, done);
  });
}

const PREVIEW_LENGTH = 200;

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Marks up to `limit` pending receipts as delivered and returns them as items,
 * in `control_seq` order. A gone member ignores the limit (§6.5).
 */
function takeControls(db: DatabaseSync, memberId: string, limit: number): ControlItem[] {
  const pending = db
    .prepare(
      `SELECT control_seq FROM control_receipts
       WHERE to_id = ? AND state = 'pending' ORDER BY control_seq LIMIT ?`,
    )
    .all(memberId, limit) as unknown as { control_seq: number }[];
  if (pending.length === 0) return [];

  const deliveredAt = Date.now();
  const markDelivered = db.prepare(
    "UPDATE control_receipts SET state = 'delivered', delivered_at = ? WHERE control_seq = ? AND to_id = ?",
  );
  const selectControl = db.prepare('SELECT * FROM controls WHERE seq = ?');
  const items: ControlItem[] = [];
  for (const entry of pending) {
    const controlSeq = Number(entry.control_seq);
    markDelivered.run(deliveredAt, controlSeq, memberId);
    const control = selectControl.get(controlSeq) as unknown as ControlRow | undefined;
    if (!control) continue;
    items.push({
      kind: 'control',
      control_seq: controlSeq,
      id: control.id,
      from_id: control.from_id,
      cmd: control.cmd,
      payload: parseJson(control.payload_json),
      reply_to: control.reply_to,
      created_at: Number(control.created_at),
    });
  }
  return items;
}

interface InboxRow {
  seq: number;
  conv_id: string;
  msg_seq: number;
  sender_id: string;
  sender_kind: 'member' | 'human';
  body: string;
  created_at: number;
}

function gapItems(db: DatabaseSync, memberId: string, skipped: InboxRow[], kept: InboxRow[]): GapItem[] {
  const folded = new Map<string, { count: number; mentioned: number; newestSkipped: number }>();
  for (const entry of skipped) {
    const bucket = folded.get(entry.conv_id) ?? { count: 0, mentioned: 0, newestSkipped: 0 };
    bucket.count += 1;
    bucket.newestSkipped = Math.max(bucket.newestSkipped, Number(entry.msg_seq));
    if (mentionExists(db, entry.conv_id, Number(entry.msg_seq), memberId)) bucket.mentioned += 1;
    folded.set(entry.conv_id, bucket);
  }

  const gaps: GapItem[] = [];
  for (const [convId, bucket] of folded) {
    const oldestKept = kept.find((entry) => entry.conv_id === convId);
    gaps.push({
      kind: 'gap',
      to: convId,
      count: bucket.count,
      before: oldestKept ? Number(oldestKept.msg_seq) : bucket.newestSkipped + 1,
      mentioned: bucket.mentioned,
    });
  }
  gaps.sort((left, right) => (left.to < right.to ? -1 : left.to > right.to ? 1 : 0));
  return gaps;
}

function messageItem(db: DatabaseSync, memberId: string, parentId: string | null, entry: InboxRow): MessageItem {
  return {
    kind: 'message',
    to: entry.conv_id,
    seq: Number(entry.msg_seq),
    from_id: entry.sender_id,
    from_name: senderName(db, entry.sender_id, entry.sender_kind),
    from_kind: entry.sender_kind,
    preview: entry.body.slice(0, PREVIEW_LENGTH),
    mentions_me: mentionExists(db, entry.conv_id, Number(entry.msg_seq), memberId),
    from_parent: parentId !== null && entry.sender_id === parentId,
    at: Number(entry.created_at),
  };
}

/**
 * One settlement pass of `GET /v1/poll` (design §6.5). Everything the pass
 * changes happens inside one write transaction that is released before the
 * request starts waiting.
 */
export function consumeOnce(db: DatabaseSync, memberId: string, limit: number, types: PollTypes): ConsumeResult {
  return tx(db, () => {
    const member = getMember(db, memberId);
    if (!member) return { gone: true } as ConsumeResult;

    if (member.status === 'gone') {
      // A gone member ignores `types` and the limit: it drains the termination
      // notice, then gets 410 forever after (§8.3).
      const items = takeControls(db, memberId, Number.MAX_SAFE_INTEGER);
      if (items.length === 0) return { gone: true } as ConsumeResult;
      return { gone: false, items, control_pending: 0 } as ConsumeResult;
    }

    // `types` filters consumption as well as delivery (§6.2).
    const deliveredControls = types.control ? takeControls(db, memberId, limit) : [];

    let gaps: GapItem[] = [];
    let messages: MessageItem[] = [];
    if (types.message) {
      const cursor = memberCursor(db, memberId);
      const backlog = db
        .prepare(
          `SELECT i.seq AS seq, i.conv_id AS conv_id, i.msg_seq AS msg_seq,
                  m.sender_id AS sender_id, m.sender_kind AS sender_kind,
                  m.body AS body, m.created_at AS created_at
           FROM inbox i
           JOIN messages m ON m.conv_id = i.conv_id AND m.seq = i.msg_seq
           WHERE i.member_id = ? AND i.seq > ?
           ORDER BY i.seq`,
        )
        .all(memberId, cursor) as unknown as InboxRow[];

      let kept = backlog;
      if (backlog.length > limit) {
        // Delivered messages are a suffix of the delivery order, so every
        // conversation's skipped part is one contiguous prefix.
        kept = backlog.slice(backlog.length - limit);
        gaps = gapItems(db, memberId, backlog.slice(0, backlog.length - limit), kept);
      }
      messages = kept.map((entry) => messageItem(db, memberId, member.parent_id, entry));

      if (kept.length > 0) {
        const newest = Number(kept[kept.length - 1].seq);
        db.prepare(
          `INSERT INTO member_cursors (member_id, last_seq) VALUES (?, ?)
           ON CONFLICT(member_id) DO UPDATE SET last_seq = excluded.last_seq`,
        ).run(memberId, newest);
      }
    }

    return {
      gone: false,
      items: [...deliveredControls, ...gaps, ...messages],
      control_pending: pendingReceiptCount(db, memberId),
    } as ConsumeResult;
  });
}
