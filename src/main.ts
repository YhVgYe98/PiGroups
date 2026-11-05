import { createAdaptorServer, type HttpBindings, type Http2Bindings } from '@hono/node-server';
import type { Hono } from 'hono';
import { appendFileSync, readdirSync, rmdirSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from './app.ts';
import type { AppEnv } from './context.ts';
import { openDatabase } from './db.ts';
import { readEndpoint, writeEndpoint } from './endpoint.ts';
import { isProcessAlive, resolvePlatform, type PlatformPaths } from './platform.ts';
import { bindPlatformPort, DuplicatePlatformError } from './startup.ts';
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

const seedPort = listenPort();
const startedAt = Date.now();

/**
 * Until the database and the real app exist, the listener answers just enough
 * to be identified: another start of this platform must be able to tell "this
 * port is mine, I am starting" from "this port belongs to something else".
 * Every other request waits for the app (503), which is what a client polling
 * `/v1/health` already expects.
 */
let platformId = '';
function startingResponse(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === '/v1/health') {
    return Response.json(
      {
        status: 'starting',
        version: SERVER_VERSION,
        uptime_ms: Date.now() - startedAt,
        platform_id: platformId,
        server_version: SERVER_VERSION,
      },
      { status: 503 },
    );
  }
  return Response.json(
    {
      error: { code: 'starting', message: 'the platform is still starting', detail: {} },
      server_version: SERVER_VERSION,
    },
    { status: 503 },
  );
}

let app: Hono<AppEnv> | undefined;
const http: HttpServer = createAdaptorServer({
  // The bindings carry the socket, which `/v1/humans` reads through getConnInfo.
  // Dropping them turns a loopback request into "not from the server host".
  fetch: (request: Request, env: HttpBindings | Http2Bindings) =>
    app === undefined ? startingResponse(request) : app.fetch(request, env),
}) as HttpServer;

let layout: PlatformPaths | undefined;
let resolvedPaths: PlatformPaths | undefined;
let opened: DatabaseSync | undefined;
let boundPort = 0;

try {
  layout = await resolvePlatform({
    onResolved: async (paths) => {
      platformId = paths.platformId;
      resolvedPaths = paths;
      // An existing platform always meets its successor on the port it recorded,
      // whatever PORT this start was given. That is what makes the bind a lock:
      // two starters with different PORT values still compete for one port.
      const recorded = readEndpoint(paths.platformDir);
      const firstPort =
        recorded !== null && recorded.platform_id === paths.platformId ? recorded.port : seedPort;

      const bound = await bindPlatformPort({
        platformId: paths.platformId,
        firstPort,
        server: http,
        identifyHolder: () => {
          const record = readEndpoint(paths.platformDir);
          if (record === null || record.platform_id !== paths.platformId) return undefined;
          if (!isProcessAlive(record.pid)) return undefined;
          return { port: record.port };
        },
      });
      boundPort = bound.port;

      // Before the database: the adapter needs the port while the platform is
      // still starting, and a competitor may probe at any moment.
      writeEndpoint(paths.platformDir, {
        platform_id: paths.platformId,
        port: boundPort,
        version: SERVER_VERSION,
        pid: process.pid,
        updated_at: Date.now(),
      });

      // One turn of the event loop so a probe that arrived between the bind and
      // here is answered with the `starting` identity. `openDatabase` is
      // synchronous: a probe that arrives during it waits in the socket backlog.
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

      opened = openDatabase(paths.platformDir, { platformId: paths.platformId });
      app = createApp({ db: opened, startedAt, platformId: paths.platformId });
    },
  });
} catch (error) {
  if (http.listening) {
    try {
      http.close();
    } catch {
      // The startup failure is the error worth reporting.
    }
  }
  if (error instanceof DuplicatePlatformError) {
    console.error(
      `[pigroups] duplicate: ${error.message}; another process already serves this platform, ` +
        `so this start exits without touching its data`,
    );
    process.exit(2);
  }
  removeEmptyPlatformDir(resolvedPaths);
  fail(error);
}

/**
 * A refused start must not leave a directory that looks like a half-created
 * platform. Only an empty directory is removed: if adoption moved a database in,
 * or the endpoint record was already written, there is something to keep.
 */
function removeEmptyPlatformDir(paths: PlatformPaths | undefined): void {
  if (paths === undefined) return;
  try {
    if (readdirSync(paths.platformDir).length > 0) return;
    rmdirSync(paths.platformDir);
  } catch {
    // Best effort: an empty leftover is not a platform and blocks nothing.
  }
}

if (opened === undefined) fail(new Error('platform resolution did not open a database'));
if (layout === undefined) fail(new Error('platform resolution did not return a layout'));

function afterStartupFailure(error: unknown): never {
  console.error(`[pigroups] server error on port ${boundPort}: ${reason(error)}`);
  try {
    opened?.close();
  } catch {
    // The process is exiting; the server error is the one to report.
  }
  process.exit(1);
}

http.on('error', afterStartupFailure);

// The log line is written before the readiness line: a data root that cannot
// take one more line must not be announced as ready first.
try {
  appendFileSync(
    layout.logPath,
    `${new Date().toISOString()} listening on ${boundPort} (server ${SERVER_VERSION}, platform ${layout.platformId})\n`,
  );
} catch (error) {
  console.error(`[pigroups] cannot write ${layout.logPath}: ${reason(error)}`);
}
console.log(`listening on ${boundPort}`);

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  http.close();
  (http as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  opened?.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
