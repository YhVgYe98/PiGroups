import { serve } from '@hono/node-server';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';
import { resolvePlatform, type PlatformPaths } from './platform.ts';
import { SERVER_VERSION } from './version.ts';

const DEFAULT_PORT = 7717;

function listenPort(): number {
  const parsed = Number.parseInt(process.env.PORT ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
}

function fail(error: unknown): never {
  console.error(`[pigroups] ${reason(error)}`);
  process.exit(1);
}

const port = listenPort();

/**
 * Bind the port before touching any data. Adopting a 0.2.0 database moves the
 * only copy of it; doing that and only then discovering that the port is taken
 * would leave the data somewhere nobody asked for while the service stays down.
 */
async function probePort(): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, () => {
      probe.close(() => resolve());
    });
  });
}

try {
  await probePort();
} catch (error) {
  console.error(`[pigroups] cannot listen on ${port}: ${reason(error)}`);
  process.exit(1);
}

let layout: PlatformPaths;
let opened: DatabaseSync | undefined;
try {
  layout = resolvePlatform({
    onResolved: (paths) => {
      // Open while the startup lock is held: a just-created platform directory
      // must already contain a database before another process looks for one.
      opened = openDatabase(paths.platformDir, { platformId: paths.platformId });
    },
  });
} catch (error) {
  fail(error);
}

if (opened === undefined) fail(new Error('platform resolution did not open a database'));
const db: DatabaseSync = opened;

const app = createApp({
  db,
  startedAt: Date.now(),
  platformId: layout.platformId,
});

function listenFailure(error: unknown): never {
  console.error(`[pigroups] cannot listen on ${port}: ${reason(error)}`);
  try {
    db.close();
  } catch {
    // The process is exiting; the listen error is the one to report.
  }
  process.exit(1);
}

/**
 * Errors a listening server reports later (accept-time resource exhaustion, a
 * broken socket) are not listen failures: the port was bound, so saying
 * "cannot listen" would send the operator looking in the wrong place.
 */
function afterStartupFailure(error: unknown): never {
  console.error(`[pigroups] server error on port ${port}: ${reason(error)}`);
  try {
    db.close();
  } catch {
    // The process is exiting; the server error is the one to report.
  }
  process.exit(1);
}

let onServerError: (error: unknown) => never = listenFailure;
let server: ReturnType<typeof serve> | undefined;
try {
  server = serve({ fetch: app.fetch, port }, (info) => {
    onServerError = afterStartupFailure;
    // The log line is written before the readiness line: a data root that
    // cannot take one more line must not be announced as ready first.
    try {
      appendFileSync(
        layout.logPath,
        `${new Date().toISOString()} listening on ${info.port} (server ${SERVER_VERSION}, platform ${layout.platformId})\n`,
      );
    } catch (error) {
      console.error(`[pigroups] cannot write ${layout.logPath}: ${reason(error)}`);
    }
    console.log(`listening on ${info.port}`);
  });
} catch (error) {
  listenFailure(error);
}

const running = server;
if (running === undefined) listenFailure(new Error('server was not created'));
running.on('error', (error) => onServerError(error));
const closable = running as unknown as { close: () => void; closeAllConnections?: () => void };

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  closable.close();
  closable.closeAllConnections?.();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
