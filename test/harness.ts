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
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
/** Absolute path, so a server can be started from any working directory. */
const ENTRY_POINT = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;

/** `POST /v1/humans` needs PIGROUPS_ADMIN_TOKEN in the environment and on the request. */
export const ADMIN_TOKEN = 'pigroups-test-admin-token';

export type Json = any;

export type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };

export type ExitResult = ExitStatus & { stdout: string; stderr: string; pid: number };

export type Server = {
  port: number;
  baseUrl: string;
  /** The platform process, so tests can compare it with the endpoint record. */
  pid: number;
  /** The data root the server was started with (a temporary one when none was given). */
  dataDir: string;
  /** Everything the process has written to stdout so far. */
  stdout: () => string;
  /** Everything the process has written to stderr so far. */
  stderr: () => string;
  stop: () => Promise<ExitStatus>;
  /** SIGKILL, leaving the data root (and every record in it) exactly as it was. */
  crash: () => Promise<ExitStatus>;
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

/** A port that is free right now; a seed for a test that needs to name one. */
export async function freePortNumber(): Promise<number> {
  return findFreePort();
}

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

function spawnedEnv(
  port: number,
  dataDir: string,
  adminToken: string | false | undefined,
  platformId: string | undefined,
  omitDataDir: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    PIGROUPS_ADMIN_TOKEN: ADMIN_TOKEN,
  };
  delete env.PIGROUPS_PLATFORM_ID;
  delete env.PIGROUPS_DATA;
  if (!omitDataDir) env.PIGROUPS_DATA = dataDir;
  if (platformId !== undefined) env.PIGROUPS_PLATFORM_ID = platformId;
  if (adminToken === false) delete env.PIGROUPS_ADMIN_TOKEN;
  else if (typeof adminToken === 'string') env.PIGROUPS_ADMIN_TOKEN = adminToken;
  return env;
}

async function shutdown(child: ChildProcess): Promise<ExitStatus> {
  if (child.pid === undefined) return { code: null, signal: null };
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
      child.kill('SIGKILL');
      await waitForExit(child, STOP_TIMEOUT_MS);
    }
  }
  return { code: child.exitCode, signal: child.signalCode };
}

export type StartOptions = {
  /** Reuse an existing data directory; stop() then leaves it in place for a restart. */
  dataDir?: string;
  /** Override the admin token the server is started with; false leaves it unset. */
  adminToken?: string | false;
  /** Select a platform under <dataDir>/platforms instead of letting the server choose one. */
  platformId?: string;
  /** Working directory for the process; also implies the caller cleans up after itself. */
  cwd?: string;
  /** Leave PIGROUPS_DATA unset, so the default data root under `cwd` is used. */
  omitDataDir?: boolean;
  /** Do not pre-create the data directory; the server is expected to create it. */
  createDataDir?: boolean;
  /**
   * The port to hand the platform as its first candidate. The platform may bind
   * this one or advance past an occupied candidate; `port` on the result is the
   * port it actually bound.
   */
  seedPort?: number;
};

/**
 * Spawn the server, resolve once it prints `listening on <port>`, else fail loudly.
 * A port can be taken between `findFreePort` and the child's bind; that is a
 * scheduling accident, so it is retried instead of failing a whole test file.
 */
export async function startServer(options: StartOptions = {}): Promise<Server> {
  const ownsDataDir = options.dataDir === undefined && options.cwd === undefined;
  const cwd = options.cwd ?? REPO_ROOT;
  const dataDir =
    options.dataDir ??
    (options.omitDataDir === true
      ? join(cwd, '.pigroups')
      : await mkdtemp(join(tmpdir(), 'pigroups-test-')));
  if (!ownsDataDir && options.createDataDir !== false) await mkdir(dataDir, { recursive: true });

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = options.seedPort ?? (await findFreePort());
    try {
      return await spawnServer(port, options, { ownsDataDir, cwd, dataDir });
    } catch (error) {
      lastError = error;
      if (!String(error).includes('EADDRINUSE') || attempt === 2) break;
    }
  }
  if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
  throw lastError;
}

async function spawnServer(
  port: number,
  options: StartOptions,
  where: { ownsDataDir: boolean; cwd: string; dataDir: string },
): Promise<Server> {
  const { ownsDataDir, cwd, dataDir } = where;
  const child = spawn(process.execPath, [ENTRY_POINT], {
    cwd,
    env: spawnedEnv(port, dataDir, options.adminToken, options.platformId, options.omitDataDir === true),
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

  const expected = `listening on a port`;
  let actualPort = 0;
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
      for (const line of output.stdout.split('\n')) {
        const match = /^listening on (\d+)$/.exec(line.trim());
        if (match !== null) {
          actualPort = Number.parseInt(match[1], 10);
          succeed();
          return;
        }
      }
      if (exitNote !== null) fail(exitNote);
    };
    child.stdout!.on('data', scan);
    child.on('exit', () => fail(exitNote ?? 'the process exited before printing the readiness line'));
    scan();
  }).catch(async (error: unknown) => {
    await shutdown(child);
    throw error;
  });

  let stopped = false;
  const stop = async (): Promise<ExitStatus> => {
    if (stopped) return { code: child.exitCode, signal: child.signalCode };
    stopped = true;
    const status = await shutdown(child);
    if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
    return status;
  };
  const crash = async (): Promise<ExitStatus> => {
    if (stopped) return { code: child.exitCode, signal: child.signalCode };
    stopped = true;
    child.kill('SIGKILL');
    await waitForExit(child, STOP_TIMEOUT_MS);
    return { code: child.exitCode, signal: child.signalCode };
  };

  const actual = actualPort === 0 ? port : actualPort;
  return {
    port: actual,
    baseUrl: `http://127.0.0.1:${actual}`,
    pid: child.pid ?? 0,
    dataDir,
    stdout: () => output.stdout,
    stderr: () => output.stderr,
    stop,
    crash,
  };
}

/**
 * Spawn the server without waiting for readiness. Needed when the test must
 * observe the window between the bind and the ready line (the database open can
 * be blocked on purpose).
 */
export function spawnRaw(options: {
  dataDir: string;
  platformId?: string;
  /** Omit to leave PORT unset, so the platform uses its default. */
  seedPort?: number;
}): {
  pid: number;
  stdout: () => string;
  stderr: () => string;
  waitForExit: (timeoutMs: number) => Promise<ExitStatus>;
  kill: (signal?: NodeJS.Signals) => void;
} {
  const env = spawnedEnv(options.seedPort ?? 0, options.dataDir, undefined, options.platformId, false);
  if (options.seedPort === undefined) delete env.PORT;
  const child = spawn(process.execPath, [ENTRY_POINT], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr!.on('data', (chunk: string) => {
    output.stderr += chunk;
  });
  return {
    pid: child.pid ?? 0,
    stdout: () => output.stdout,
    stderr: () => output.stderr,
    waitForExit: async (timeoutMs: number): Promise<ExitStatus> => {
      const exited = await waitForExit(child, timeoutMs);
      return exited ? { code: child.exitCode, signal: child.signalCode } : { code: null, signal: null };
    },
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      child.kill(signal);
    },
  };
}

export type RunToExitOptions = {
  dataDir: string;
  /** Select a platform explicitly; without it the environment variable is unset. */
  platformId?: string;
  /** Bind this port instead of allocating one (use with `holdPort` to force EADDRINUSE). */
  port?: number;
  /** Working directory for the process. */
  cwd?: string;
  /** Extra environment entries for this process only. */
  env?: Record<string, string>;
};

/**
 * Spawn the server and wait until it exits. A refusal must exit quickly; a
 * server that starts instead is killed and reported as a failure.
 */
export async function runToExit(options: RunToExitOptions): Promise<ExitResult> {
  const port = options.port ?? (await findFreePort());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    PIGROUPS_DATA: options.dataDir,
    ...options.env,
  };
  delete env.PIGROUPS_PLATFORM_ID;
  if (options.platformId !== undefined) env.PIGROUPS_PLATFORM_ID = options.platformId;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY_POINT], {
      cwd: options.cwd ?? REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`server did not refuse to start\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
    }, 10_000);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, pid: child.pid ?? 0 });
    });
  });
}

/** Every directory under platform/, including leftovers that hold no database. */
export async function platformDirs(dataRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(dataRoot, 'platforms'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function databasePath(dataRoot: string, platformId: string): string {
  return join(dataRoot, 'platforms', platformId, 'pigroups.db');
}

export function startLockPath(dataRoot: string): string {
  return join(dataRoot, 'platforms', '.start.lock');
}

/** Write a startup lock by hand; a string is written verbatim, anything else as JSON. */
export function writeStartLock(dataRoot: string, contents: unknown): string {
  mkdirSync(join(dataRoot, 'platforms'), { recursive: true });
  const lockPath = startLockPath(dataRoot);
  writeFileSync(lockPath, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return lockPath;
}

/** A pid that is guaranteed not to be running, for a stale-lock fixture. */
export function deadPid(): number {
  for (let pid = 999_999; pid > 1000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('could not find a dead pid for the lock fixture');
}

export function metaRows(databasePathname: string): Record<string, string> {
  const db = new DatabaseSync(databasePathname, { readOnly: true });
  try {
    const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  } finally {
    db.close();
  }
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

/** A listening socket on a fixed port, so a server started next to it cannot bind. */
export async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const holder = createServer();
  const sockets = new Set<Socket>();
  holder.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.listen(0, '127.0.0.1', () => resolve());
  });
  const address = holder.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    throw new Error('could not allocate a held TCP port');
  }
  return {
    port: address.port,
    release: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    },
  };
}

/** A listening socket on a specific address, to prove what the loopback probe can reach. */
export async function holdAddress(host: string): Promise<{ port: number; release: () => Promise<void> }> {
  const holder = createServer();
  const sockets = new Set<Socket>();
  holder.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.listen(0, host, () => resolve());
  });
  const address = holder.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    throw new Error(`could not bind ${host}`);
  }
  return {
    port: address.port,
    release: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    },
  };
}

/**
 * A responder whose answers are scripted per request. Used to prove which probe
 * produced which answer: a body without `platform_id` is "no answer", a body
 * with one is the positive fact.
 */
export async function holdScriptedHealth(
  replies: Array<{ status?: number; body: unknown }>,
): Promise<{ port: number; requests: () => Array<{ path: string; at: number }>; release: () => Promise<void> }> {
  const seen: Array<{ path: string; at: number }> = [];
  const holder = createHttpServer((request, response) => {
    seen.push({ path: request.url ?? '', at: Date.now() });
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.listen(0, '127.0.0.1', () => resolve());
  });
  const address = holder.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    throw new Error('could not allocate a scripted health port');
  }
  return {
    port: address.port,
    requests: () => [...seen],
    release: () =>
      new Promise<void>((resolve) => {
        holder.closeAllConnections();
        holder.close(() => resolve());
      }),
  };
}

/** An HTTP service on one fixed port; undefined when the host will not give it. */
export async function holdHttpAt(port: number): Promise<{ port: number; release: () => Promise<void> } | undefined> {
  const holder = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ hello: 'not a pigroups platform' }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.listen(port, '127.0.0.1', () => resolve());
    });
  } catch {
    return undefined;
  }
  return {
    port,
    release: () =>
      new Promise<void>((resolve) => {
        holder.closeAllConnections();
        holder.close(() => resolve());
      }),
  };
}

/**
 * An unrelated HTTP service on a fixed port. Unlike `holdPort`, it answers, so a
 * starting platform has positive evidence that the port is not its own and is
 * allowed to move to the next candidate.
 */
export async function holdHttpPort(
  body: unknown = { hello: 'not a pigroups platform' },
): Promise<{ port: number; release: () => Promise<void> }> {
  const holder = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.listen(0, '127.0.0.1', () => resolve());
  });
  const address = holder.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    throw new Error('could not allocate a held HTTP port');
  }
  return {
    port: address.port,
    release: () => new Promise<void>((resolve) => holder.close(() => resolve())),
  };
}

export function endpointPath(dataRoot: string, platformId: string): string {
  return join(dataRoot, 'platforms', platformId, 'endpoint.json');
}

export function readEndpointRecord(dataRoot: string, platformId: string): Record<string, any> {
  return JSON.parse(readFileSync(endpointPath(dataRoot, platformId), 'utf8')) as Record<string, any>;
}
