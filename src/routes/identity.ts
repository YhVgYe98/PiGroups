import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext, AppEnv } from '../context.ts';
import { tx } from '../db.ts';
import { alreadyBootstrapped, forbidden, nameTaken } from '../errors.ts';
import { activePrincipal, ok, optionalName, readJson } from '../http.ts';
import { hashToken, newId, newToken, randomName, tokensMatch } from '../ids.ts';
import { type HumanRow, type MemberRow, getHuman, getMember, isNameTaken } from '../store.ts';
import { SERVER_VERSION } from '../version.ts';
import { conversationItems, dmRefsOf, groupRefsOf, memberView } from '../views.ts';

function nextMemberName(db: DatabaseSync): string {
  for (;;) {
    const candidate = randomName();
    if (!isNameTaken(db, candidate)) return candidate;
  }
}

function nextHumanName(db: DatabaseSync): string {
  for (;;) {
    const candidate = randomName();
    if (db.prepare('SELECT 1 FROM humans WHERE name = ?').get(candidate) === undefined) return candidate;
  }
}

function humanNameTaken(db: DatabaseSync, name: string): boolean {
  return db.prepare('SELECT 1 FROM humans WHERE name = ?').get(name) !== undefined;
}

function isLoopback(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

function requestIsLoopback(c: Context<AppEnv>): boolean {
  try {
    const info = getConnInfo(c as unknown as Context);
    return isLoopback(info.remote.address ?? '');
  } catch {
    return false;
  }
}

function presentedBearer(c: Context<AppEnv>): string {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : '';
}

export function registerIdentityRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  const { db, startedAt } = ctx;

  app.post('/v1/bootstrap', async (c) => {
    const body = await readJson(c);
    const requestedName = optionalName(body, 'name');

    const created = tx(db, () => {
      if (db.prepare('SELECT 1 FROM members WHERE is_root = 1').get() !== undefined) throw alreadyBootstrapped();
      if (requestedName !== undefined && isNameTaken(db, requestedName)) throw nameTaken(requestedName);
      const id = newId('m');
      const token = newToken();
      const createdAt = Date.now();
      const name = requestedName ?? nextMemberName(db);
      db.prepare(
        `INSERT INTO members (id, name, parent_id, is_root, status, token_hash, request_id, created_at)
         VALUES (?, ?, NULL, 1, 'alive', ?, NULL, ?)`,
      ).run(id, name, hashToken(token), createdAt);
      const member = getMember(db, id);
      if (!member) throw new Error('root member vanished after insert');
      return { member: memberView(db, member), token };
    });

    return ok(c, created);
  });

  app.post('/v1/humans', async (c) => {
    // A human reads every conversation, so it must not be manufacturable by a
    // member token or by anything else on loopback: the endpoint needs the admin
    // token from the environment and is closed when that is unset (concept §6,
    // design §10.2).
    const adminToken = process.env.PIGROUPS_ADMIN_TOKEN;
    if (adminToken === undefined || adminToken === '') {
      throw forbidden('human creation is disabled: PIGROUPS_ADMIN_TOKEN is not set');
    }
    if (!requestIsLoopback(c)) throw forbidden('humans can only be created from the server host');
    if (!tokensMatch(presentedBearer(c), adminToken)) throw forbidden('PIGROUPS_ADMIN_TOKEN is required');

    const body = await readJson(c);
    const requestedName = optionalName(body, 'name');

    const created = tx(db, () => {
      if (requestedName !== undefined && humanNameTaken(db, requestedName)) throw nameTaken(requestedName);
      const id = newId('h');
      const token = newToken();
      const createdAt = Date.now();
      const name = requestedName ?? nextHumanName(db);
      db.prepare('INSERT INTO humans (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, NULL)').run(
        id,
        name,
        hashToken(token),
        createdAt,
      );
      const human = getHuman(db, id);
      if (!human) throw new Error('human vanished after insert');
      return {
        human: {
          id: human.id,
          name: human.name,
          created_at: human.created_at,
          last_seen_at: human.last_seen_at,
        },
        token,
      };
    });

    return ok(c, created);
  });

  app.get('/v1/whoami', (c) => {
    const principal = activePrincipal(c);
    if (principal.kind === 'human') {
      const human: HumanRow = principal.human;
      return ok(c, {
        kind: 'human',
        human: {
          id: human.id,
          name: human.name,
          created_at: human.created_at,
          last_seen_at: human.last_seen_at,
        },
        conversations: conversationItems(db, principal).map((item) => ({ to: item.to, kind: item.kind })),
        last_seen_at: human.last_seen_at,
        server: { version: SERVER_VERSION },
      });
    }

    const member: MemberRow = principal.member;
    return ok(c, {
      kind: 'member',
      member: memberView(db, member),
      groups: groupRefsOf(db, member),
      dms: dmRefsOf(db, member.id),
      last_seen_at: member.last_seen_at,
      server: { version: SERVER_VERSION },
    });
  });

  app.get('/v1/health', (c) => {
    return ok(c, {
      status: 'ok',
      version: SERVER_VERSION,
      uptime_ms: Date.now() - startedAt,
    });
  });
}
