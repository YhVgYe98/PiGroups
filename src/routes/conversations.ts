import type { Hono } from 'hono';
import type { AppContext, AppEnv, Principal } from '../context.ts';
import { tx } from '../db.ts';
import { badRequest, forbidden, memberGone, noSuchGroup, notFound, payloadTooLarge, unknownMention } from '../errors.ts';
import {
  MAX_MESSAGE_BODY_BYTES,
  MAX_META_BYTES,
  activePrincipal,
  assertCanWrite,
  byteLength,
  clamp,
  intQuery,
  ok,
  optionalString,
  optionalStringArray,
  principalId,
  readJson,
} from '../http.ts';
import { isAllMention } from '../ids.ts';
import { wakeMembers } from '../feed.ts';
import {
  type MessageRow,
  dmConvId,
  getMember,
  groupMembers,
  inboxRecipients,
  mentionsOf,
  parseDmConv,
  senderName,
} from '../store.ts';
import { conversationItems } from '../views.ts';

const MEMBER_ID = /^[mh]_[0-9a-f]+$/;

function resolveConversationId(principal: Principal, raw: string): string {
  if (raw.startsWith('g:')) return raw;
  if (raw.startsWith('dm:')) {
    if (!parseDmConv(raw)) throw badRequest('to is not a valid one-to-one conversation id');
    return raw;
  }
  if (MEMBER_ID.test(raw)) {
    if (principal.kind !== 'member') throw forbidden('humans have no one-to-one conversations');
    return dmConvId(principal.member.id, raw);
  }
  throw badRequest('to must be a conversation id or a member id');
}

function assertReadable(principal: Principal, convId: string): void {
  if (principal.kind === 'human') return;
  const me = principal.member;
  if (convId.startsWith('g:')) {
    const ownerId = convId.slice(2);
    if (me.id === ownerId || me.parent_id === ownerId) return;
    throw forbidden('you are not a member of this group');
  }
  const parsed = parseDmConv(convId);
  if (!parsed) throw badRequest('to is not a valid conversation id');
  if (me.id === parsed.a || me.id === parsed.b) return;
  throw forbidden('you are not part of this conversation');
}

export function registerConversationRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  const { db, hub } = ctx;

  app.get('/v1/conversations', (c) => {
    const principal = activePrincipal(c);
    return ok(c, { items: conversationItems(db, principal) });
  });

  app.post('/v1/messages', async (c) => {
    const principal = activePrincipal(c);
    const body = await readJson(c);

    const to = typeof body.to === 'string' ? body.to : undefined;
    if (to === undefined || to === '') throw badRequest('to is required');
    if (to.startsWith('dm:')) throw badRequest('write side takes "g:<owner>" or a member id');
    if (typeof body.body !== 'string') throw badRequest('body must be a string');
    const text = body.body;
    const textSize = byteLength(text);
    if (textSize > MAX_MESSAGE_BODY_BYTES) throw payloadTooLarge(MAX_MESSAGE_BODY_BYTES, textSize);

    const requestedMentions = optionalStringArray(body, 'mentions') ?? [];
    // An empty key is not a key: `""` is normalised to NULL, so it neither
    // collides with itself in `ux_msg_idem` nor replays (§12).
    const rawClientMsgId = optionalString(body, 'client_msg_id');
    const clientMsgId = rawClientMsgId === '' ? undefined : rawClientMsgId;
    let metaJson: string | null = null;
    if (body.meta !== undefined && body.meta !== null) {
      metaJson = JSON.stringify(body.meta);
      const metaSize = byteLength(metaJson);
      if (metaSize > MAX_META_BYTES) throw payloadTooLarge(MAX_META_BYTES, metaSize);
    }

    const senderId = principalId(principal);
    const senderKind = principal.kind;
    const createdAt = Date.now();

    const result = tx(db, () => {
      // The middleware saw the caller at request start; a `DELETE` may have
      // committed while the body was being read, so the ban on writing after
      // `gone` is re-checked inside the write transaction (§8.3).
      assertCanWrite(db, principal);

      // A replay answers with the stored result before any target or group
      // validation: the recipient may be gone or the group empty by now, and the
      // answer is still the original `seq` (§7.1, §12).
      if (clientMsgId !== undefined) {
        const existing = db
          .prepare('SELECT * FROM messages WHERE sender_id = ? AND client_msg_id = ?')
          .get(senderId, clientMsgId) as unknown as MessageRow | undefined;
        if (existing) {
          return {
            to: existing.conv_id,
            seq: Number(existing.seq),
            recipients: inboxRecipients(db, existing.conv_id, Number(existing.seq)),
            created_at: Number(existing.created_at),
          };
        }
      }

      let convId: string;
      let recipients: string[];
      let mentions: string[] = [];

      if (to.startsWith('g:')) {
        const ownerId = to.slice(2);
        const group = groupMembers(db, ownerId);
        if (group.length === 0) throw noSuchGroup(ownerId);
        const groupIds = group.map((entry) => entry.id);
        if (principal.kind === 'member' && !groupIds.includes(senderId)) {
          throw forbidden('you are not a member of this group');
        }
        recipients = groupIds.filter((id) => id !== senderId);

        const groupSet = new Set(groupIds);
        const mentionSet = new Set<string>();
        for (const mention of requestedMentions) {
          if (isAllMention(mention)) {
            // `@all` is expanded at write time into a snapshot of the group (§5.2)
            for (const id of groupSet) mentionSet.add(id);
            continue;
          }
          if (!groupSet.has(mention)) throw unknownMention(mention);
          mentionSet.add(mention);
        }
        mentions = [...mentionSet].sort();
        convId = `g:${ownerId}`;
      } else {
        if (principal.kind !== 'member') throw forbidden('humans have no one-to-one conversations');
        if (to === senderId) throw badRequest('cannot send a one-to-one message to yourself');
        const target = getMember(db, to);
        if (!target) throw notFound('member not found');
        if (target.status !== 'alive') throw memberGone(target.id);
        if (requestedMentions.length > 0) throw badRequest('mentions are not allowed in a one-to-one conversation');
        convId = dmConvId(senderId, target.id);
        recipients = [target.id];
      }

      db.prepare('INSERT INTO conversation_seqs (conv_id, last_seq) VALUES (?, 0) ON CONFLICT(conv_id) DO NOTHING').run(
        convId,
      );
      db.prepare('UPDATE conversation_seqs SET last_seq = last_seq + 1 WHERE conv_id = ?').run(convId);
      const counter = db.prepare('SELECT last_seq FROM conversation_seqs WHERE conv_id = ?').get(convId) as unknown as {
        last_seq: number;
      };
      const seq = Number(counter.last_seq);

      db.prepare(
        `INSERT INTO messages (conv_id, seq, sender_id, sender_kind, client_msg_id, body, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(convId, seq, senderId, senderKind, clientMsgId ?? null, text, metaJson, createdAt);

      const insertMention = db.prepare('INSERT INTO mentions (conv_id, msg_seq, member_id) VALUES (?, ?, ?)');
      for (const mentionId of mentions) insertMention.run(convId, seq, mentionId);

      const insertInbox = db.prepare(
        'INSERT INTO inbox (member_id, conv_id, msg_seq, created_at) VALUES (?, ?, ?, ?)',
      );
      for (const recipient of recipients) insertInbox.run(recipient, convId, seq, createdAt);

      return { to: convId, seq, recipients, created_at: createdAt };
    });

    wakeMembers(hub, result.recipients);
    return ok(c, result);
  });

  app.get('/v1/messages', (c) => {
    const principal = activePrincipal(c);
    const rawTo = c.req.query('to');
    if (rawTo === undefined || rawTo === '') throw badRequest('to is required');
    const convId = resolveConversationId(principal, rawTo);
    assertReadable(principal, convId);

    const before = Math.trunc(intQuery(c, 'before') ?? Number.MAX_SAFE_INTEGER);
    const limit = Math.trunc(clamp(intQuery(c, 'limit') ?? 50, 1, 200));

    const found = db
      .prepare('SELECT * FROM messages WHERE conv_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
      .all(convId, before, limit) as unknown as MessageRow[];
    const ascending = found.slice().reverse();

    const items = ascending.map((message) => ({
      to: message.conv_id,
      seq: Number(message.seq),
      sender_id: message.sender_id,
      sender_kind: message.sender_kind,
      sender_name: senderName(db, message.sender_id, message.sender_kind),
      body: message.body,
      meta: message.meta_json === null ? null : (JSON.parse(message.meta_json) as unknown),
      mentions: mentionsOf(db, message.conv_id, Number(message.seq)),
      created_at: Number(message.created_at),
    }));

    // `next` is the `before` value for the previous page, and `null` once the
    // page has reached the oldest message (§5.3).
    const oldestServed = ascending.length > 0 ? Number(ascending[0].seq) : null;
    const hasOlder =
      oldestServed !== null &&
      db.prepare('SELECT 1 FROM messages WHERE conv_id = ? AND seq < ? LIMIT 1').get(convId, oldestServed) !== undefined;
    const next = hasOlder ? oldestServed : null;

    return ok(c, { items, next });
  });
}
