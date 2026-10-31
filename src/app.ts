import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { DatabaseSync } from 'node:sqlite';
import { createAuthMiddleware } from './auth.ts';
import type { AppContext, AppEnv } from './context.ts';
import { ApiError } from './errors.ts';
import { createPollHub } from './feed.ts';
import { registerControlRoutes } from './routes/control.ts';
import { registerConversationRoutes } from './routes/conversations.ts';
import { registerIdentityRoutes } from './routes/identity.ts';
import { registerOrgRoutes } from './routes/org.ts';
import { registerPollRoutes } from './routes/poll.ts';
import { SERVER_VERSION } from './version.ts';

/** Everything under these paths needs a bearer token; health and bootstrap do not. */
const AUTH_PATHS = [
  '/v1/whoami',
  '/v1/members',
  '/v1/members/*',
  '/v1/tree',
  '/v1/conversations',
  '/v1/messages',
  '/v1/poll',
  '/v1/control',
];

export function createApp(options: { db: DatabaseSync; startedAt: number }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const ctx: AppContext = {
    db: options.db,
    hub: createPollHub(),
    startedAt: options.startedAt,
  };

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(
        {
          error: { code: error.code, message: error.message, detail: error.detail },
          server_version: SERVER_VERSION,
        },
        error.status as ContentfulStatusCode,
        error.headers,
      );
    }
    console.error('[pigroups] unhandled error:', error);
    return c.json(
      {
        error: { code: 'internal_error', message: 'internal server error', detail: {} },
        server_version: SERVER_VERSION,
      },
      500,
    );
  });

  app.notFound((c) =>
    c.json(
      { error: { code: 'not_found', message: 'no such endpoint', detail: {} }, server_version: SERVER_VERSION },
      404,
    ),
  );

  const auth = createAuthMiddleware(ctx.db);
  for (const path of AUTH_PATHS) app.use(path, auth);

  registerIdentityRoutes(app, ctx);
  registerOrgRoutes(app, ctx);
  registerConversationRoutes(app, ctx);
  registerPollRoutes(app, ctx);
  registerControlRoutes(app, ctx);

  return app;
}
