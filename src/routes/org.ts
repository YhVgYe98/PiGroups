import type { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext, AppEnv } from '../context.ts';
import { tx } from '../db.ts';
import { forbidden, memberGone, nameTaken, notFound, rootProtected } from '../errors.ts';
import { activeMember, activePrincipal, ok, optionalString, readJson } from '../http.ts';
import { hashToken, newId, newToken, randomName } from '../ids.ts';
import { wakeMembers } from '../feed.ts';
import {
  type MemberRow,
  aliveSubtreeIds,
  getMember,
  isInOwnSubtree,
  isNameTaken,
  placeholders,
} from '../store.ts';
import { memberView } from '../views.ts';

function nextMemberName(db: DatabaseSync): string {
  for (;;) {
    const candidate = randomName();
    if (!isNameTaken(db, candidate)) return candidate;
  }
}

export function registerOrgRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  const { db, hub } = ctx;

  app.post('/v1/members', async (c) => {
    const principal = activePrincipal(c);
    if (principal.kind !== 'member') throw forbidden('humans cannot create members');
    const body = await readJson(c);
    const requestId = optionalString(body, 'request_id');
    const requestedName = optionalString(body, 'name');

    const created = tx(db, () => {
      const caller = getMember(db, principal.member.id);
      if (!caller || caller.status !== 'alive') throw memberGone(principal.member.id);

      // Replaying a creation returns the original member; the plaintext token
      // was never stored, so it cannot be returned again (§8.1).
      if (requestId !== undefined && requestId !== '') {
        const existing = db
          .prepare('SELECT * FROM members WHERE parent_id = ? AND request_id = ?')
          .get(caller.id, requestId) as unknown as MemberRow | undefined;
        if (existing) return { member: memberView(db, existing) };
      }

      if (requestedName !== undefined && isNameTaken(db, requestedName)) throw nameTaken(requestedName);
      const id = newId('m');
      const token = newToken();
      const createdAt = Date.now();
      const name = requestedName ?? nextMemberName(db);
      db.prepare(
        `INSERT INTO members (id, name, parent_id, is_root, status, token_hash, request_id, created_at)
         VALUES (?, ?, ?, 0, 'alive', ?, ?, ?)`,
      ).run(id, name, caller.id, hashToken(token), requestId ?? null, createdAt);

      const member = getMember(db, id);
      if (!member) throw new Error('member vanished after insert');
      return { member: memberView(db, member), token };
    });

    return ok(c, created);
  });

  app.get('/v1/members/:id', (c) => {
    activePrincipal(c);
    const member = getMember(db, c.req.param('id'));
    if (!member) throw notFound('member not found');
    return ok(c, { ...memberView(db, member) });
  });

  app.delete('/v1/members/:id', (c) => {
    const caller = activeMember(c);
    const target = getMember(db, c.req.param('id'));
    if (!target) throw notFound('member not found');
    if (!isInOwnSubtree(db, caller.id, target.id)) throw forbidden('target is outside your own subtree');
    if (target.is_root === 1) throw rootProtected();

    const terminated = tx(db, () => {
      const alive = aliveSubtreeIds(db, target.id);

      // 1. Instructions aimed at members that are about to disappear are moot;
      //    the only receipt they may keep is the termination notice below.
      if (alive.length > 0) {
        db.prepare(
          `DELETE FROM control_receipts WHERE state = 'pending' AND to_id IN (${placeholders(alive.length)})`,
        ).run(...alive);
      }

      const createdAt = Date.now();
      const insertControl = db.prepare(
        `INSERT INTO controls (id, from_id, to_json, cmd, payload_json, reply_to, created_at)
         VALUES (?, 'sys', ?, 'sys.terminated', ?, NULL, ?)`,
      );
      const insertReceipt = db.prepare(
        "INSERT INTO control_receipts (control_seq, to_id, state) VALUES (?, ?, 'pending')",
      );

      // 2. One termination notice per node, sent as the platform itself.
      for (const nodeId of alive) {
        const payload = JSON.stringify({ reason: 'deleted', terminated_by: caller.id });
        const info = insertControl.run(`terminate:${nodeId}`, nodeId, payload, createdAt);
        insertReceipt.run(Number(info.lastInsertRowid), nodeId);
      }

      // 3. The whole subtree becomes gone in the same transaction, so no member
      //    can slip a child in while the cascade runs.
      if (alive.length > 0) {
        db.prepare(
          `UPDATE members SET status = 'gone', gone_at = ?, gone_reason = 'deleted'
           WHERE id IN (${placeholders(alive.length)}) AND status = 'alive'`,
        ).run(createdAt, ...alive);
      }

      return alive;
    });

    wakeMembers(hub, terminated);
    return ok(c, { terminated });
  });

  app.post('/v1/members/:id/token', (c) => {
    const caller = activeMember(c);
    const target = getMember(db, c.req.param('id'));
    if (!target) throw notFound('member not found');
    if (target.parent_id !== caller.id) throw forbidden('only the creator may reissue a token');
    if (target.status === 'gone') throw memberGone(target.id);

    const token = newToken();
    db.prepare('UPDATE members SET token_hash = ? WHERE id = ?').run(hashToken(token), target.id);
    return ok(c, { token });
  });

  app.get('/v1/tree', (c) => {
    activePrincipal(c);
    const found = db
      .prepare(
        `SELECT m.id AS id, m.name AS name, m.parent_id AS parent_id, m.last_seen_at AS last_seen_at,
                (SELECT COUNT(*) FROM members c WHERE c.parent_id = m.id AND c.status = 'alive') AS child_count
         FROM members m
         WHERE m.status = 'alive'
         ORDER BY m.created_at, m.id`,
      )
      .all() as unknown as { id: string; name: string; parent_id: string | null; last_seen_at: number | null; child_count: number }[];

    return ok(c, {
      nodes: found.map((entry) => ({
        id: entry.id,
        name: entry.name,
        parent_id: entry.parent_id,
        child_count: Number(entry.child_count),
        last_seen_at: entry.last_seen_at,
      })),
    });
  });
}
