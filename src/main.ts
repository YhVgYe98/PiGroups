import { createAdaptorServer, type HttpBindings, type Http2Bindings } from '@hono/node-server';
import type { Hono } from 'hono';
import { appendFileSync, existsSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from './app.ts';
import type { AppEnv } from './context.ts';
import { openDatabase } from './db.ts';
import {
  createEndpointExclusive,
  endpointPath,
  readEndpoint,
  writeEndpoint,
  type EndpointRecord,
} from './endpoint.ts';
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
let opened: DatabaseSync | undefined;
let boundPort = 0;

try {
  layout = resolvePlatform();
} catch (error) {
  fail(error);
}
if (layout === undefined) fail(new Error('platform resolution did not return a layout'));
const paths = layout;
platformId = paths.platformId;

/**
 * The record is the port rendezvous. It is created only when none exists, with
 * the seed port as its first candidate. A starter publishes each advanced
 * candidate before trying it, so a competitor follows the same port; after a
 * successful bind it is rewritten with the bound port. A live holder's record
 * is never overwritten before the bind decides. An existing unreadable record
 * is fail-closed: it may be the only witness of a live platform.
 */
let record: EndpointRecord | null = null;
let createdRecord = false;
try {
  record = readEndpoint(paths.platformDir);
  if (record === null) {
    const recordPath = endpointPath(paths.platformDir);
    if (existsSync(recordPath)) {
      // Another starter may have created the file a moment ago and still be
      // writing it. Give it a short window before treating the record as corrupt.
      record = await readEndpointEventually(paths.platformDir);
      if (record === null) {
        fail(
          new Error(
            `refusing to start: ${recordPath} exists but is not a readable endpoint record. ` +
              'Remove it by hand only if no platform is serving this data root.',
          ),
        );
      }
    }
  }

  if (record === null) {
    // PORT only seeds a platform with no record. An existing record supplies
    // the first candidate, so an invalid PORT is irrelevant on a restart.
    if (!Number.isInteger(seedPort) || seedPort < 1 || seedPort > 65_535) {
      removeEmptyPlatformDir(paths);
      fail(new Error(`cannot listen on ${seedPort}: port must be between 1 and 65535`));
    }

    const initial: EndpointRecord = {
      platform_id: paths.platformId,
      port: seedPort,
      version: SERVER_VERSION,
      pid: process.pid,
      updated_at: Date.now(),
    };
    if (createEndpointExclusive(paths.platformDir, initial)) {
      createdRecord = true;
      record = initial;
    } else {
      // Another starter created the file first. It writes the record in one
      // `wx` call; retry briefly if the read lands between create and write.
      record = await readEndpointEventually(paths.platformDir);
      if (record === null) {
        fail(
          new Error(
            `refusing to start: another process created ${endpointPath(paths.platformDir)} ` +
              'but it could not be read. Remove it by hand if that process is gone.',
          ),
        );
      }
    }
  }
} catch (error) {
  // I/O failures while reading or creating the record are startup failures too:
  // keep the one-line `[pigroups]` contract and clean up an empty platform dir.
  removeEmptyPlatformDir(paths);
  fail(error);
}

if (record === null) fail(new Error('endpoint record disappeared during startup'));
if (record.platform_id !== paths.platformId) {
  fail(
    new Error(
      `refusing to start: ${endpointPath(paths.platformDir)} names platform ${record.platform_id}, ` +
        `but this directory is ${paths.platformId}. ` +
        `Rename the directory back to ${record.platform_id}, or remove the record by hand if you intend a new platform.`,
    ),
  );
}

try {
  const firstPort = record.port;
  const bound = await bindPlatformPort({
    platformId: paths.platformId,
    firstPort,
    server: http,
    identifyHolder: () => {
      const current = readEndpoint(paths.platformDir);
      if (current === null || current.platform_id !== paths.platformId) return undefined;
      // Our own pre-bind claim must never identify us as "another holder":
      // otherwise every occupied seed port would look like a duplicate.
      if (current.pid === process.pid) return undefined;
      if (!isProcessAlive(current.pid)) return undefined;
      return { port: current.port };
    },
    onCandidate: (candidate) => {
      // The first candidate is already published: the `wx` claim carries it, or
      // the existing record named it. Re-writing it would race a peer's
      // post-bind write; only an advanced candidate needs publishing.
      if (candidate === firstPort) return;
      const current = readEndpoint(paths.platformDir);
      if (current !== null && current.platform_id === paths.platformId) {
        const heldByAnother = current.pid !== process.pid && isProcessAlive(current.pid);
        // A live holder's record is its own; do not overwrite it before the bind
        // decides. An absent, dead, or own record is ours to publish.
        if (heldByAnother) return;
      }
      writeEndpoint(paths.platformDir, {
        platform_id: paths.platformId,
        port: candidate,
        version: SERVER_VERSION,
        pid: process.pid,
        updated_at: Date.now(),
      });
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
} catch (error) {
  if (http.listening) {
    try {
      http.close();
    } catch {
      // The startup failure is the error worth reporting.
    }
  }
  if (error instanceof DuplicatePlatformError) {
    // A duplicate must not remove a record: the winner may not have rewritten
    // its own pid yet, and this process created the file it is looking at.
    console.error(
      `[pigroups] duplicate: ${error.message}; another process already serves this platform, ` +
        `so this start exits without touching its data`,
    );
    process.exit(2);
  }
  cleanupCreatedRecord(paths, createdRecord);
  fail(error);
}

/**
 * A failed start removes only the record it created. An existing record is the
 * port rendezvous for the next start; a duplicate must not touch it at all.
 */
function cleanupCreatedRecord(paths: PlatformPaths, created: boolean): void {
  if (!created) return;
  const current = readEndpoint(paths.platformDir);
  if (current === null || current.pid !== process.pid) return;
  try {
    unlinkSync(endpointPath(paths.platformDir));
  } catch {
    // The cleanup is best effort; the original failure is the one to report.
  }
  removeEmptyPlatformDir(paths);
}

/**
 * A refused start must not leave a directory that looks like a half-created
 * platform. Only an empty directory is removed: if a database was opened or the
 * record belongs to another process, there is something to keep.
 */
function removeEmptyPlatformDir(paths: PlatformPaths): void {
  try {
    if (readdirSync(paths.platformDir).length > 0) return;
    rmdirSync(paths.platformDir);
  } catch {
    // Best effort: an empty leftover is not a platform and blocks nothing.
  }
}

async function readEndpointEventually(platformDir: string): Promise<EndpointRecord | null> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = readEndpoint(platformDir);
    if (current !== null) return current;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  return null;
}

if (opened === undefined) fail(new Error('platform startup did not open a database'));

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
    paths.logPath,
    `${new Date().toISOString()} listening on ${boundPort} (server ${SERVER_VERSION}, platform ${paths.platformId})\n`,
  );
} catch (error) {
  console.error(`[pigroups] cannot write ${paths.logPath}: ${reason(error)}`);
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
