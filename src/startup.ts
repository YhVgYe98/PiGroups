/**
 * Binding the platform's port (design §11).
 *
 * The listening socket *is* the single-instance lock. The operating system
 * decides between two processes that bind the same address and port; the loser
 * gets `EADDRINUSE` and has to answer one question: is the socket held by a
 * process serving *this* platform?
 *
 * Only a positive answer ends the start: the holder names this `platform_id`.
 * Every other outcome — a different platform, an HTTP service that is not
 * PiGroups, a refusal, a timeout — is "no answer yet", so the candidate gets a
 * second probe. Two probes that do not name this platform move the start to the
 * next port.
 *
 * The one answer that does not come from the network is the platform's own
 * record. It is created before the bind with the current candidate and rewritten
 * after it, so it can carry the same `platform_id` and port while the event loop
 * is blocked and both probes time out. Without it, a platform opening a large
 * database would be classified as "not us" and a second process would open the
 * same file.
 */

import type { Server as HttpServer } from 'node:http';

/** How long one identity probe may take before it counts as "no answer". */
export const PORT_PROBE_TIMEOUT_MS = 1_000;
/** The pause between the two probes of the same candidate. */
export const PORT_PROBE_INTERVAL_MS = 150;

const MAX_PORT = 65_535;

/** The candidate port is held by the platform we were asked to start. */
export class DuplicatePlatformError extends Error {
  readonly platformId: string;
  readonly port: number;
  readonly status: string;

  constructor(platformId: string, port: number, status: string) {
    super(`platform ${platformId} is already bound on port ${port} (status ${status})`);
    this.name = 'DuplicatePlatformError';
    this.platformId = platformId;
    this.port = port;
    this.status = status;
  }
}

/**
 * The one fact worth having: the holder's own platform id. Anything else —
 * another service, an error page, a refused connection, a timeout — is
 * `undefined`, because none of it answers "is this our platform?".
 */
async function probeIdentity(port: number): Promise<{ platformId: string; status: string } | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (body !== null && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      if (typeof record.platform_id === 'string' && record.platform_id !== '') {
        return {
          platformId: record.platform_id,
          status: typeof record.status === 'string' ? record.status : 'unknown',
        };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bind `server` to `firstPort`, or to the first port above it that this
 * platform may own. The server is left listening when this resolves; on any
 * failure it is not listening.
 */
export async function bindPlatformPort(options: {
  platformId: string;
  firstPort: number;
  server: HttpServer;
  /**
   * The platform's own record, read when both probes stayed silent. It carries the
   * same fact a healthy answer would (`platform_id`, this port), and it is written
   * between the bind and the database open, so it can identify a platform that is
   * blocked opening its database.
   */
  identifyHolder?: () => { port: number } | undefined;
  /**
   * Called with every candidate before it is tried. The record is the rendezvous:
   * a starter that walks past an occupied seed must publish the new candidate so a
   * competitor follows it instead of binding the abandoned seed.
   */
  onCandidate?: (port: number) => void;
}): Promise<{ port: number }> {
  const { platformId, server } = options;
  let port = options.firstPort;

  for (;;) {
    options.onCandidate?.(port);
    try {
      await listen(server, port);
      return { port };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`cannot listen on ${port}: ${message}`);
      }

      // Two probes with a pause between them. Only a positive answer — this
      // platform's id — may end the start; every other outcome gets the second
      // probe and, if it is still not positive, moves on to the next port.
      const first = await probeIdentity(port);
      if (first !== undefined && first.platformId === platformId) {
        throw new DuplicatePlatformError(platformId, port, first.status);
      }
      await sleep(PORT_PROBE_INTERVAL_MS);
      const second = await probeIdentity(port);
      if (second !== undefined && second.platformId === platformId) {
        throw new DuplicatePlatformError(platformId, port, second.status);
      }

      // Neither probe answered. The record carries the same positive fact and is
      // written before the synchronous database open, which can block the event
      // loop past both probes. Without it, this is "not us" and we move on.
      const holder = options.identifyHolder?.();
      if (holder !== undefined && holder.port === port) {
        throw new DuplicatePlatformError(platformId, port, 'starting');
      }

      if (port >= MAX_PORT) {
        throw new Error(
          `cannot listen on any port from ${options.firstPort} to ${MAX_PORT}: every candidate is in use`,
        );
      }
      port += 1;
    }
  }
}
