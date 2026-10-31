import type { MiddlewareHandler } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { AppEnv } from './context.ts';
import { invalidToken } from './errors.ts';
import { hashToken } from './ids.ts';
import { getHumanByToken, getMemberByToken } from './store.ts';

/**
 * Bearer token authentication. `last_seen_at` is refreshed here, as its own
 * statement, so a long poll cannot hold the activity time back (design §9).
 */
export function createAuthMiddleware(db: DatabaseSync): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match) throw invalidToken();
    const tokenHash = hashToken(match[1]);
    const seenAt = Date.now();

    const member = getMemberByToken(db, tokenHash);
    if (member) {
      db.prepare('UPDATE members SET last_seen_at = ? WHERE id = ?').run(seenAt, member.id);
      member.last_seen_at = seenAt;
      c.set('principal', { kind: 'member', member });
      await next();
      return;
    }

    const human = getHumanByToken(db, tokenHash);
    if (human) {
      db.prepare('UPDATE humans SET last_seen_at = ? WHERE id = ?').run(seenAt, human.id);
      human.last_seen_at = seenAt;
      c.set('principal', { kind: 'human', human });
      await next();
      return;
    }

    throw invalidToken();
  };
}
