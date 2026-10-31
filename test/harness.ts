/**
 * Black-box harness for the PiGroups HTTP contract.
 *
 * Each test file spawns its own `src/main.ts` on a free port with a fresh data
 * directory, waits for the readiness line the runtime contract mandates
 * (`listening on <port>`), and talks to it only over HTTP with a member or
 * human token. Nothing here imports the implementation.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;

/** `POST /v1/humans` needs PIGROUPS_ADMIN_TOKEN in the environment and on the request. */
export const ADMIN_TOKEN = 'pigroups-test-admin-token';

export type Json = any;

export type Server = {
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
};

export type Principal = { id: string; token: string; name: string };

export type Reply = {
  status: number;
  /** Response headers keyed by their lower-cased name, as fetch reports them. */
  headers: Record<string, string>;
  body: Json;
  text: string;
};

export type CallOptions = {
  token?: string;
  body?: Json;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
};

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    throw new Error('could not allocate a free TCP port');
  }
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function spawnedEnv(port: number, dataDir: string, adminToken: string | false | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    PIGROUPS_DATA: dataDir,
    PIGROUPS_ADMIN_TOKEN: ADMIN_TOKEN,
  };
  if (adminToken === false) delete env.PIGROUPS_ADMIN_TOKEN;
  else if (typeof adminToken === 'string') env.PIGROUPS_ADMIN_TOKEN = adminToken;
  return env;
}

async function shutdown(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return;
  child.kill('SIGKILL');
  await waitForExit(child, STOP_TIMEOUT_MS);
}

export type StartOptions = {
  /** Reuse an existing data directory; stop() then leaves it in place for a restart. */
  dataDir?: string;
  /** Override the admin token the server is started with; false leaves it unset. */
  adminToken?: string | false;
};

/** Spawn the server, resolve once it prints `listening on <port>`, else fail loudly. */
export async function startServer(options: StartOptions = {}): Promise<Server> {
  const port = await findFreePort();
  const ownsDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'pigroups-test-')));
  if (!ownsDataDir) await mkdir(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: REPO_ROOT,
    env: spawnedEnv(port, dataDir, options.adminToken),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = { stdout: '', stderr: '' };
  let exitNote: string | null = null;

  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr!.on('data', (chunk: string) => {
    output.stderr += chunk;
  });
  child.on('exit', (code, signal) => {
    exitNote = `the process exited (code=${String(code)}, signal=${String(signal)}) before printing the readiness line`;
  });
  child.on('error', (error) => {
    exitNote = `spawn failed: ${error.message}`;
  });

  const expected = `listening on ${port}`;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `server did not become ready: ${reason}\n` +
            `--- stdout ---\n${output.stdout}\n--- stderr ---\n${output.stderr}`,
        ),
      );
    };
    const timer = setTimeout(
      () => fail(`no "${expected}" line within ${READY_TIMEOUT_MS}ms`),
      READY_TIMEOUT_MS,
    );
    const scan = () => {
      if (output.stdout.split('\n').some((line) => line.trim() === expected)) succeed();
      else if (exitNote !== null) fail(exitNote);
    };
    child.stdout!.on('data', scan);
    child.on('exit', () => fail(exitNote ?? 'the process exited before printing the readiness line'));
    scan();
  }).catch(async (error: unknown) => {
    await shutdown(child);
    if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
    throw error;
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await shutdown(child);
    if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
  };

  return { port, baseUrl: `http://127.0.0.1:${port}`, stop };
}

export async function call(
  server: Server,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Reply> {
  const url = new URL(server.baseUrl + path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const requestHeaders: Record<string, string> = {};
  const init: RequestInit = { method, headers: requestHeaders };
  if (options.token !== undefined) requestHeaders.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.timeoutMs !== undefined) init.signal = AbortSignal.timeout(options.timeoutMs);

  const response = await fetch(url, init);
  const text = await response.text();
  let body: Json = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, text };
}

export function assertStatus(reply: Reply, expected: number, what: string): void {
  assert.equal(reply.status, expected, `${what}: expected HTTP ${expected}, got ${reply.status} — ${reply.text}`);
}

export function assertOk(reply: Reply, what: string): void {
  assert.ok(
    reply.status >= 200 && reply.status < 300,
    `${what}: expected 2xx, got ${reply.status} — ${reply.text}`,
  );
}

export function assertErrorCode(reply: Reply, expected: string, what: string): void {
  assert.equal(reply.body?.error?.code, expected, `${what}: expected error code ${expected} — ${reply.text}`);
}

export function groupConversation(ownerId: string): string {
  return `g:${ownerId}`;
}

export function dmConversation(a: string, b: string): string {
  return `dm:${[a, b].sort().join('_')}`;
}

/** `groups` / `conversations` may be reported as bare ids or as `{to, …}` objects. */
export function conversationId(entry: Json): string | undefined {
  if (typeof entry === 'string') return entry;
  return typeof entry?.to === 'string' ? entry.to : undefined;
}

export async function bootstrapRoot(server: Server, name = 'root'): Promise<Principal> {
  const reply = await call(server, 'POST', '/v1/bootstrap', { body: { name } });
  assertOk(reply, 'POST /v1/bootstrap');
  return { id: reply.body.member.id, token: reply.body.token, name: reply.body.member.name };
}

export async function spawnMember(server: Server, parent: Principal, name: string): Promise<Principal> {
  const reply = await call(server, 'POST', '/v1/members', {
    token: parent.token,
    body: { name, request_id: `req-${name}` },
  });
  assertOk(reply, `POST /v1/members (${name})`);
  assert.equal(typeof reply.body.token, 'string', `POST /v1/members (${name}) must return a token`);
  return { id: reply.body.member.id, token: reply.body.token, name: reply.body.member.name };
}

export async function createHuman(server: Server, name: string): Promise<Principal> {
  const reply = await call(server, 'POST', '/v1/humans', { token: ADMIN_TOKEN, body: { name } });
  assertOk(reply, 'POST /v1/humans');
  return { id: reply.body.human.id, token: reply.body.token, name: reply.body.human.name };
}

export async function sendMessage(
  server: Server,
  sender: Principal,
  to: string,
  body: string,
  extra: Json = {},
): Promise<Json> {
  const reply = await call(server, 'POST', '/v1/messages', {
    token: sender.token,
    body: { to, body, ...extra },
  });
  assertOk(reply, `POST /v1/messages from ${sender.name} to ${to}`);
  return reply.body;
}

export async function sendControl(
  server: Server,
  sender: Principal,
  to: string | string[],
  id: string,
  cmd: string,
  extra: Json = {},
): Promise<Json> {
  const reply = await call(server, 'POST', '/v1/control', {
    token: sender.token,
    body: { to, id, cmd, ...extra },
  });
  assertOk(reply, `POST /v1/control ${id}`);
  return reply.body;
}

/** One consuming poll that must succeed; returns the response body. */
export async function poll(
  server: Server,
  principal: Principal,
  query: Record<string, string | number> = {},
  timeoutMs = 10_000,
): Promise<Json> {
  const reply = await call(server, 'GET', '/v1/poll', {
    token: principal.token,
    query: { wait: 0, ...query },
    timeoutMs,
  });
  assertStatus(reply, 200, `GET /v1/poll as ${principal.name}`);
  return reply.body;
}
