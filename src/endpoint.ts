/**
 * The platform's current listening endpoint (design §11).
 *
 * `PORT` seeds a platform that has no record yet. Once a platform has bound a
 * port, that port is the rendezvous every later start of the same platform must
 * try first — otherwise two starters that pass different `PORT` values would
 * never meet, and port binding could not decide between them.
 *
 * The record is a hint, never an ownership proof. Ownership is the listening
 * socket itself; a process that dies leaves this file behind and the next start
 * simply binds the recorded port again (or advances past whatever took it).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ENDPOINT_FILE = 'endpoint.json';

export interface EndpointRecord {
  platform_id: string;
  port: number;
  /** The server version that wrote the record; a hint for diagnostics only. */
  version: string;
  /** The process that bound the port. A later start compares it to its own child. */
  pid: number;
  updated_at: number;
}

export function endpointPath(platformDir: string): string {
  return join(platformDir, ENDPOINT_FILE);
}

/**
 * A malformed or half-written record is `null`, not an error: it carries no
 * authority, so the only thing to do with a broken one is ignore it and fall
 * back to the seed port.
 */
export function readEndpoint(platformDir: string): EndpointRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(endpointPath(platformDir), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const port = record.port;
    if (typeof record.platform_id !== 'string' || record.platform_id === '') return null;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    return {
      platform_id: record.platform_id,
      port,
      version: typeof record.version === 'string' ? record.version : '',
      pid: typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : 0,
      updated_at: typeof record.updated_at === 'number' ? record.updated_at : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Write through a sibling temp file and `rename`, so a reader never sees half a
 * record. Called immediately after a successful bind, before the database is
 * opened: the adapter needs the port while the platform is still starting.
 */
export function writeEndpoint(platformDir: string, record: EndpointRecord): void {
  mkdirSync(platformDir, { recursive: true });
  const target = endpointPath(platformDir);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}
