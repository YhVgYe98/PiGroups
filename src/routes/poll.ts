import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../context.ts';
import { badRequest, memberGone, pollInProgress, forbidden } from '../errors.ts';
import { clamp, intQuery, ok, principalOf } from '../http.ts';
import { type PollTypes, consumeOnce, waitForWake } from '../feed.ts';

const DEFAULT_WAIT_SECONDS = 25;
const DEFAULT_LIMIT = 20;

/**
 * `types` accepts `message`, `control` and `all` (the default). An unknown token
 * is an error rather than an empty set: silently consuming nothing parks the
 * member and looks exactly like "no news" (§6.2).
 */
function parseTypes(raw: string | undefined): PollTypes {
  if (raw === undefined) return { message: true, control: true };
  const requested = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (requested.length === 0) return { message: true, control: true };

  const types: PollTypes = { message: false, control: false };
  for (const token of requested) {
    if (token === 'all') {
      types.message = true;
      types.control = true;
    } else if (token === 'message') {
      types.message = true;
    } else if (token === 'control') {
      types.control = true;
    } else {
      throw badRequest(`types must be message, control or all; got "${token}"`);
    }
  }
  return types;
}

export function registerPollRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  const { db, hub } = ctx;

  app.get('/v1/poll', async (c) => {
    const principal = principalOf(c);
    if (principal.kind !== 'member') throw forbidden('humans cannot poll');
    const memberId = principal.member.id;

    // One waiting poll per member (§6.6).
    if (hub.inflight.has(memberId)) throw pollInProgress();
    hub.inflight.add(memberId);
    try {
      const waitSeconds = clamp(intQuery(c, 'wait') ?? DEFAULT_WAIT_SECONDS, 0, 50);
      const limit = Math.trunc(clamp(intQuery(c, 'limit') ?? DEFAULT_LIMIT, 1, 50));
      const types = parseTypes(c.req.query('types'));
      const deadline = Date.now() + waitSeconds * 1000;

      for (;;) {
        // Each pass is its own short write transaction; the wait below holds none.
        const result = consumeOnce(db, memberId, limit, types);
        if (result.gone) throw memberGone(memberId);
        if (result.items.length > 0) {
          return ok(c, { items: result.items, control_pending: result.control_pending });
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return ok(c, { items: [], control_pending: result.control_pending });
        }
        await waitForWake(hub, memberId, remaining);
      }
    } finally {
      hub.inflight.delete(memberId);
    }
  });
}
