import type { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
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

/** The per-recipient list, the same shape in both views of §7.3. */
function receiptViews(db: DatabaseSync, controlSeq: number) {
  return receiptsFor(db, controlSeq).map((receipt) => ({
    to_id: receipt.to_id,
    state: receipt.state,
    delivered_at: receipt.delivered_at,
  }));
}

type ControlPage = { items: unknown[]; next: number | null };

/**
 * `to_json` holds JSON for every control written since §7.3. A row written by an
 * older build's `sys.terminated` holds a bare member id instead (`m_635f7e`). The
 * audit of a delete must not 500 on the row that explains the delete, so a value
 * that is not JSON is returned as the text it is. `openDatabase` rewrites those
 * rows once at startup; this is the belt to that migration's braces, and it also
 * covers a row that reached the table by another writer.
 */
function parseStoredTo(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * The full view of §7.3: every instruction across all senders and recipients,
 * `cmd` and `payload` included. Only a human reaches this, and only a human
 * token is the reason the content can be shown at all.
 */
function allControlPage(
  db: DatabaseSync,
  since: number,
  limit: number,
  fromId: string | undefined,
  to: string | undefined,
): ControlPage {
  const filters: string[] = [];
  const filterParams: string[] = [];
  if (fromId !== undefined) {
    filters.push('from_id = ?');
    filterParams.push(fromId);
  }
  if (to !== undefined) {
    // `to` matches the request form as it was stored, so a group address is read
    // back as the group address that was written (§7.3).
    filters.push('to_json = ?');
    filterParams.push(JSON.stringify(to));
  }
  const where = ['seq > ?', ...filters].join(' AND ');

  const found = db
    .prepare(`SELECT * FROM controls WHERE ${where} ORDER BY seq ASC LIMIT ?`)
    .all(since, ...filterParams, limit) as unknown as ControlRow[];

  const items = found.map((control) => ({
    seq: Number(control.seq),
    id: control.id,
    from_id: control.from_id,
    to: parseStoredTo(control.to_json),
    cmd: control.cmd,
    payload: control.payload_json === null ? null : (JSON.parse(control.payload_json) as unknown),
    reply_to: control.reply_to,
    receipts: receiptViews(db, Number(control.seq)),
    created_at: Number(control.created_at),
  }));

  let next: number | null = null;
  if (items.length > 0) {
    const lastSeq = items[items.length - 1].seq;
    const more = db.prepare(`SELECT 1 FROM controls WHERE ${where} LIMIT 1`).get(lastSeq, ...filterParams);
    next = more === undefined ? null : lastSeq;
  }
  return { items, next };
}

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
    // The presence of `all` decides, not its value: `?all`, `?all=1` and
    // `?all=TRUE` have to be refused for a member instead of sliding into the
    // plain view, which is the only permissive branch here (§7.3).
    if (c.req.query('all') !== undefined) {
      if (principal.kind !== 'human') throw forbidden('only a human may read every instruction');
      return ok(
        c,
        allControlPage(
          db,
          Math.trunc(intQuery(c, 'since') ?? 0),
          Math.trunc(clamp(intQuery(c, 'limit') ?? 50, 1, 200)),
          c.req.query('from_id') || undefined,
          c.req.query('to') || undefined,
        ),
      );
    }

    const fromId = principalId(principal);
    const since = Math.trunc(intQuery(c, 'since') ?? 0);
    const limit = Math.trunc(clamp(intQuery(c, 'limit') ?? 50, 1, 200));

    const found = db
      .prepare('SELECT * FROM controls WHERE from_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(fromId, since, limit) as unknown as ControlRow[];

    const items = found.map((control) => ({
      seq: Number(control.seq),
      id: control.id,
      to: parseStoredTo(control.to_json),
      receipts: receiptViews(db, Number(control.seq)),
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
