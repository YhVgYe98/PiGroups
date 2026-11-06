/**
 * The platform's endpoint record (design §11).
 *
 * `PORT` seeds a platform that has no record yet. Once a platform has bound a
 * port, that port is the rendezvous every later start of the same platform must
 * try first — otherwise two starters that pass different `PORT` values would
 * never meet, and port binding could not decide between them.
 *
 * The record is a port rendezvous, not an ownership proof. Ownership is the
 * listening socket itself; a process that dies leaves this file behind and the
 * next start simply binds the recorded port again (or advances past whatever
 * took it). The record is created only when none exists, with the seed port as
 * its first candidate; a walking starter publishes each advanced candidate
 * before trying it, and a successful bind rewrites it with the bound port.
 *
 * A record whose fields are not usable is `null`, not an error. The caller must
 * distinguish "the file is absent" from "the file exists but cannot be read":
 * an existing unreadable record is fail-closed (a human removes it), because it
 * may be the only witness of a live platform.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ENDPOINT_FILE = 'endpoint.json';

export interface EndpointRecord {
  platform_id: string;
  port: number;
  /** The server version that wrote the record; a hint for diagnostics only. */
  version: string;
  /** The process that last wrote the record. */
  pid: number;
  updated_at: number;
}

export function endpointPath(platformDir: string): string {
  return join(platformDir, ENDPOINT_FILE);
}

/**
 * A valid record names a platform, an integer port, and a positive pid. A
 * missing pid is not a valid record: `identifyHolder` must never treat a
 * half-written file as a live owner.
 */
export function readEndpoint(platformDir: string): EndpointRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(endpointPath(platformDir), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const port = record.port;
    if (typeof record.platform_id !== 'string' || record.platform_id === '') return null;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return null;
    return {
      platform_id: record.platform_id,
      port,
      version: typeof record.version === 'string' ? record.version : '',
      pid: record.pid,
      updated_at: typeof record.updated_at === 'number' ? record.updated_at : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Create the record only when no file exists. Returns true for the creator and
 * false when another starter won; the caller then reads the winner's record and
 * binds the same port. The file is written through a single `wx` descriptor, so
 * exactly one process can create it.
 */
export function createEndpointExclusive(platformDir: string, record: EndpointRecord): boolean {
  mkdirSync(platformDir, { recursive: true });
  const target = endpointPath(platformDir);
  let fd: number | undefined;
  try {
    fd = openSync(target, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(target);
    } catch {
      // The write failure is the error worth reporting.
    }
    throw error;
  }
  closeSync(fd);
  return true;
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
