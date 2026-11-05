/**
 * Binding the platform's port (design §11).
 *
 * The listening socket *is* the single-instance lock. The operating system
 * decides between two processes that bind the same address and port; the loser
 * gets `EADDRINUSE` and has to answer one question: is the socket held by
 * another process serving *this* platform, or by something else?
 *
 * It answers with two probes of `/v1/health`. A PiGroups platform answers even
 * while it is still initialising (`status: "starting"`), so a competing start
 * can tell "same platform, wait/exit" from "someone else, try the next port".
 * Both probes matter because a process may be between binding and serving.
 *
 * The rule that is *not* obvious: two unidentifiable probes do not mean "try
 * the next port". A platform that has bound the socket but has not finished a
 * slow database migration cannot answer at all, and skipping past it would put
 * a second process on the same database — exactly what this module exists to
 * prevent. Advancing requires positive evidence that the holder is not us:
 * another PiGroups `platform_id`, or an HTTP service that is not PiGroups.
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

type Probe =
  | { kind: 'platform'; platformId: string; status: string }
  | { kind: 'foreign' }
  | { kind: 'refused' }
  | { kind: 'unknown' };

/**
 * `refused` is deliberately separate from `unknown`: a socket that vanished
 * between the failed bind and the probe should be re-bound immediately, while a
 * socket that accepts but stays silent must not be skipped.
 */
async function probeIdentity(port: number): Promise<Probe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (body !== null && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      if (typeof record.platform_id === 'string' && record.platform_id !== '') {
        return {
          kind: 'platform',
          platformId: record.platform_id,
          status: typeof record.status === 'string' ? record.status : 'unknown',
        };
      }
    }
    return { kind: 'foreign' };
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    const code = cause?.code ?? (error as { code?: unknown }).code;
    if (code === 'ECONNREFUSED') return { kind: 'refused' };
    return { kind: 'unknown' };
  }
}

function isDefinitelyNotOurs(result: Probe, platformId: string): boolean {
  if (result.kind === 'foreign') return true;
  return result.kind === 'platform' && result.platformId !== platformId;
}

function describeProbe(result: Probe): string {
  switch (result.kind) {
    case 'platform':
      return `platform ${result.platformId} (status ${result.status})`;
    case 'foreign':
      return 'an HTTP service that is not a PiGroups platform';
    case 'refused':
      return 'nothing answered';
    case 'unknown':
      return 'no answer';
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

/**
 * The bind says the port is taken, but nothing answers on 127.0.0.1. The holder is
 * bound to another address; the platform cannot identify it, so it must not skip
 * to the next port and race a possible peer. (The platform binds the wildcard, so
 * a holder on any single address still makes the bind fail.)
 */
function unprobeableRefusal(port: number): Error {
  return new Error(
    `cannot listen on ${port}: the port is held, but nothing answers GET /v1/health on 127.0.0.1. ` +
      `The holder is bound to an address this probe cannot reach, so this start cannot tell whether ` +
      `it is the same platform. Stop that process, or make it answer on the loopback address, and try again.`,
  );
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
   * Last resort when both probes stayed silent: the platform's own record can
   * still prove that this port belongs to this platform. A predecessor writes the
   * record before it opens the database, and opening can block long enough that
   * neither probe gets an answer. Callers return the record's port when the record
   * names this platform, this port, and a process that is still alive.
   */
  identifyHolder?: () => { port: number } | undefined;
}): Promise<{ port: number }> {
  const { platformId, server } = options;
  let port = options.firstPort;
  // A socket can vanish between our failed bind and the probe; one re-bind is
  // enough. A second `refused` means the holder is listening on an address that
  // 127.0.0.1 does not reach (a single interface, or ::1 only), which is "held but
  // unidentifiable", not "free".
  let refusedRetries = 0;

  for (;;) {
    try {
      await listen(server, port);
      return { port };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`cannot listen on ${port}: ${message}`);
      }

      const first = await probeIdentity(port);
      if (first.kind === 'refused') {
        if (refusedRetries > 0) throw unprobeableRefusal(port);
        refusedRetries += 1;
        continue;
      }
      if (first.kind === 'platform' && first.platformId === platformId) {
        throw new DuplicatePlatformError(platformId, port, first.status);
      }

      await sleep(PORT_PROBE_INTERVAL_MS);
      const second = await probeIdentity(port);
      if (second.kind === 'refused') {
        if (refusedRetries > 0) throw unprobeableRefusal(port);
        refusedRetries += 1;
        continue;
      }
      if (second.kind === 'platform' && second.platformId === platformId) {
        throw new DuplicatePlatformError(platformId, port, second.status);
      }

      if (!isDefinitelyNotOurs(first, platformId) && !isDefinitelyNotOurs(second, platformId)) {
        const holder = options.identifyHolder?.();
        if (holder !== undefined && holder.port === port) {
          // The record names this platform on this port, and its process is alive:
          // that is the same instance, merely too busy to answer.
          throw new DuplicatePlatformError(platformId, port, 'starting');
        }
        throw new Error(
          `cannot listen on ${port}: the port is held, but nothing identified itself as a PiGroups ` +
            `platform through GET /v1/health (probe 1: ${describeProbe(first)}; probe 2: ${describeProbe(second)}). ` +
            `A process that has bound this port but cannot answer yet may still be starting the same ` +
            `platform, so this start refuses to move to another port and race it for the database: ` +
            `that would be a second process serving one platform. Stop that process, or wait for it ` +
            `to finish starting, and try again.`,
        );
      }

      refusedRetries = 0;
      if (port >= MAX_PORT) {
        throw new Error(
          `cannot listen on any port from ${options.firstPort} to ${MAX_PORT}: every candidate is in use`,
        );
      }
      port += 1;
    }
  }
}
