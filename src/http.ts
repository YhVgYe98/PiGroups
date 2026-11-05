import type { Context } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { AppEnv, Principal } from './context.ts';
import { type MemberRow, getMember } from './store.ts';
import { badRequest, forbidden, memberGone } from './errors.ts';
import { SERVER_VERSION } from './version.ts';

/** Every response carries `server_version` (design §10). */
export function ok(c: Context<AppEnv>, body: Record<string, unknown>): Response {
  return c.json({ ...body, server_version: SERVER_VERSION });
}

export function principalOf(c: Context<AppEnv>): Principal {
  return c.get('principal');
}

/** Any authenticated subject; a `gone` member is refused (§8.3). */
export function activePrincipal(c: Context<AppEnv>): Principal {
  const principal = principalOf(c);
  if (principal.kind === 'member' && principal.member.status === 'gone') {
    throw memberGone(principal.member.id);
  }
  return principal;
}

/**
 * Member-only endpoints; humans have no structural position (§3.5). The message
 * is an argument for the routes that are not structural operations (a heartbeat
 * is a member's own fact, not a change to the tree).
 */
export function activeMember(
  c: Context<AppEnv>,
  humanMessage = 'humans cannot perform structural operations',
): MemberRow {
  const principal = activePrincipal(c);
  if (principal.kind !== 'member') throw forbidden(humanMessage);
  return principal.member;
}

export async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await c.req.json();
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // an absent or malformed body is reported by the field checks below
  }
  return {};
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${key} must be a string`);
  return value;
}

export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key);
  if (value === undefined || value === '') throw badRequest(`${key} is required`);
  return value;
}

/**
 * A name, when given, must not be empty: it is the permanent label that history
 * points at, so `""` is not a name (§4).
 */
export function optionalName(body: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(body, key);
  if (value === '') throw badRequest(`${key} must not be empty`);
  return value;
}

/**
 * Re-reads the caller inside a write transaction. The middleware's `status` is a
 * request-start snapshot, and a `DELETE` may commit while the body is being read;
 * the ban on writing after `gone` has to be held by the transaction itself (§8.3).
 */
export function assertCanWrite(db: DatabaseSync, principal: Principal): void {
  if (principal.kind !== 'member') return;
  const member = getMember(db, principal.member.id);
  if (!member || member.status !== 'alive') throw memberGone(principal.member.id);
}

export function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw badRequest(`${key} must be an array of strings`);
  }
  return value as string[];
}

export function intQuery(c: Context<AppEnv>, key: string): number | undefined {
  const raw = c.req.query(key);
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw badRequest(`${key} must be a number`);
  return value;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Size limits from the data model (§4) and the message contract (§5.1). */
export const MAX_MESSAGE_BODY_BYTES = 64 * 1024;
export const MAX_META_BYTES = 4 * 1024;
export const MAX_CONTROL_PAYLOAD_BYTES = 64 * 1024;

/** UTF-8 byte length, the unit of every size limit in the spec. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function principalId(principal: Principal): string {
  return principal.kind === 'member' ? principal.member.id : principal.human.id;
}
