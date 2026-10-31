import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../context.ts';
import { tx } from '../db.ts';
import { badRequest, forbidden, invalidCmd, memberGone, noSuchGroup, notFound, payloadTooLarge } from '../errors.ts';
import {
  MAX_CONTROL_PAYLOAD_BYTES,
  activePrincipal,
  assertCanWrite,
  byteLength,
  clamp,
  intQuery,
  ok,
  optionalString,
  principalId,
  readJson,
} from '../http.ts';
import { wakeMembers } from '../feed.ts';
import { type ControlRow, getControlBySenderKey, getMember, groupMembers, receiptsFor, sharesGroup } from '../store.ts';

const MAX_CMD_LENGTH = 200;

export function registerControlRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  const { db, hub } = ctx;

  app.post('/v1/control', async (c) => {
    const principal = activePrincipal(c);
    const body = await readJson(c);

    const controlId = typeof body.id === 'string' ? body.id : undefined;
    if (controlId === undefined || controlId === '') throw badRequest('id is required');
    const cmd = body.cmd;
    if (typeof cmd !== 'string' || cmd.length < 1 || cmd.length > MAX_CMD_LENGTH) {
      throw invalidCmd(typeof cmd === 'string' ? cmd.length : 0);
    }

    let payloadJson: string | null = null;
    if (body.payload !== undefined && body.payload !== null) {
      payloadJson = JSON.stringify(body.payload);
      const payloadSize = byteLength(payloadJson);
      if (payloadSize > MAX_CONTROL_PAYLOAD_BYTES) throw payloadTooLarge(MAX_CONTROL_PAYLOAD_BYTES, payloadSize);
    }
    const replyTo = optionalString(body, 'reply_to');

    const to = body.to;
    const toJson = JSON.stringify(to ?? null);
    if (typeof to !== 'string' && !(Array.isArray(to) && to.every((entry) => typeof entry === 'string'))) {
      throw badRequest('to must be a member id, an array of member ids, or "g:<owner>"');
    }

    const fromId = principalId(principal);
    const createdAt = Date.now();

    const outcome = tx(db, () => {
      // The middleware saw the caller at request start; a `DELETE` may have
      // committed while the body was being read, so the ban on writing after
      // `gone` is re-checked inside the write transaction (§8.3).
      assertCanWrite(db, principal);

      // `(from_id, id)` is the sender's idempotency key: a replay returns the
      // original `control_seq` before any reachability check, because the target
      // may have gone away since (§7.1, §12).
      const existing = getControlBySenderKey(db, fromId, controlId);
      if (existing) {
        return {
          response: {
            control_seq: Number(existing.seq),
            receipts: receiptsFor(db, Number(existing.seq)).map((receipt) => ({
              to_id: receipt.to_id,
              state: receipt.state,
            })),
          },
          targets: [] as string[],
        };
      }

      const targets: string[] = [];
      if (typeof to === 'string' && to.startsWith('g:')) {
        const ownerId = to.slice(2);
        const owner = getMember(db, ownerId);
        const group = groupMembers(db, ownerId);
        if (!owner || group.length === 0) throw noSuchGroup(ownerId);
        // A member may address the group it owns or the one it belongs to as a child.
        if (principal.kind === 'member' && fromId !== ownerId && principal.member.parent_id !== ownerId) {
          throw forbidden('group is outside your reach');
        }
        for (const entry of group) {
          if (entry.id !== fromId) targets.push(entry.id);
        }
      } else if (typeof to === 'string') {
        targets.push(to);
      } else {
        targets.push(...(to as string[]));
      }

      const unique = [...new Set(targets)];
      if (unique.length === 0) throw badRequest('to must name at least one target');
      for (const targetId of unique) {
        // A member may not command itself: `sharesGroup(a, a)` would pass, but
        // self is none of the parent / child / sibling cases (§7.1).
        if (targetId === fromId) throw badRequest('cannot send a control to yourself');
        const target = getMember(db, targetId);
        if (!target) throw notFound(`unknown member: ${targetId}`);
        if (target.status !== 'alive') throw memberGone(targetId);
        if (principal.kind === 'member' && !sharesGroup(db, fromId, targetId)) {
          throw forbidden(`${targetId} is not in one of your groups`);
        }
      }

      const info = db
        .prepare(
          `INSERT INTO controls (id, from_id, to_json, cmd, payload_json, reply_to, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(controlId, fromId, toJson, cmd, payloadJson, replyTo ?? null, createdAt);
      const controlSeq = Number(info.lastInsertRowid);
      const insertReceipt = db.prepare(
        "INSERT INTO control_receipts (control_seq, to_id, state) VALUES (?, ?, 'pending')",
      );
      for (const targetId of unique) insertReceipt.run(controlSeq, targetId);

      return {
        response: {
          control_seq: controlSeq,
          receipts: unique.map((toId) => ({ to_id: toId, state: 'pending' })),
        },
        targets: unique,
      };
    });

    wakeMembers(hub, outcome.targets);
    return ok(c, outcome.response);
  });

  app.get('/v1/control', (c) => {
    const principal = activePrincipal(c);
    const fromId = principalId(principal);
    const since = Math.trunc(intQuery(c, 'since') ?? 0);
    const limit = Math.trunc(clamp(intQuery(c, 'limit') ?? 50, 1, 200));

    const found = db
      .prepare('SELECT * FROM controls WHERE from_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(fromId, since, limit) as unknown as ControlRow[];

    const items = found.map((control) => ({
      seq: Number(control.seq),
      id: control.id,
      to: JSON.parse(control.to_json) as unknown,
      receipts: receiptsFor(db, Number(control.seq)).map((receipt) => ({
        to_id: receipt.to_id,
        state: receipt.state,
        delivered_at: receipt.delivered_at,
      })),
      created_at: Number(control.created_at),
    }));

    let next: number | null = null;
    if (items.length > 0) {
      const lastSeq = items[items.length - 1].seq;
      const more = db.prepare('SELECT 1 FROM controls WHERE from_id = ? AND seq > ? LIMIT 1').get(fromId, lastSeq);
      next = more === undefined ? null : lastSeq;
    }

    return ok(c, { items, next });
  });
}
