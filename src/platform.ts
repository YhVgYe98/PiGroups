import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { endpointPath } from './endpoint.ts';

export const DEFAULT_DATA_ROOT = './.pigroups';

const DATABASE_NAME = 'pigroups.db';
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;
const START_LOCK_NAME = '.start.lock';
const START_LOCK_STALE_MS = 60_000;

export interface PlatformPaths {
  /** The root that holds every platform. */
  dataRoot: string;
  platformsDir: string;
  platformId: string;
  platformDir: string;
  dbPath: string;
  logPath: string;
}

export interface ResolvePlatformOptions {
  dataRoot?: string;
  platformId?: string;
  /**
   * Runs while the startup lock is still held, once the platform directory is
   * ready. `main` binds the port and opens the database here so that a
   * concurrent process cannot see a just-created but still empty platform
   * directory and create another. It may be asynchronous; the lock is released
   * only after it settles.
   */
  onResolved?: (paths: PlatformPaths) => void | Promise<void>;
}

/**
 * One data root holds many platforms. The layout is always:
 *
 *   <dataRoot>/platforms/<platform_id>/pigroups.db
 *   <dataRoot>/platforms/<platform_id>/server.log
 *
 * `PIGROUPS_PLATFORM_ID` selects the id explicitly. Without it the server reuses
 * the only platform, creates one when the root is empty, and refuses to start
 * when the choice is ambiguous. It never guesses between existing platforms.
 *
 * A 0.2.0 data root has `pigroups.db` directly under `<dataRoot>`. When that is
 * the only database there, it is adopted into a new `platforms/<id>/` directory
 * (database, WAL, SHM and rollback journal together) instead of being ignored.
 */
export async function resolvePlatform(options: ResolvePlatformOptions = {}): Promise<PlatformPaths> {
  const dataRoot = resolve(
    options.dataRoot ?? (process.env.PIGROUPS_DATA || DEFAULT_DATA_ROOT),
  );
  const platformsDir = join(dataRoot, 'platforms');
  mkdirSync(platformsDir, { recursive: true });

  const requested = singleDirectoryName(options.platformId ?? process.env.PIGROUPS_PLATFORM_ID);

  // The lock serialises "look, then create or adopt". A platform that already has
  // an endpoint record is served by the port bind, so a data root holding several
  // of them can start them all at once. A platform *without* a record has no
  // rendezvous yet: two explicit-id starts with different PORT values would each
  // bind a private port, each write a record, and both open the same database.
  // That first start therefore takes the lock too, even with an explicit id.
  const requestedDir = requested === undefined ? undefined : join(platformsDir, requested);
  const needsLock =
    requested === undefined ||
    existsSync(join(dataRoot, DATABASE_NAME)) ||
    (requestedDir !== undefined && !existsSync(endpointPath(requestedDir)));
  const lock = needsLock ? acquireStartLock(platformsDir) : null;
  try {
    const platformId = choosePlatformId(dataRoot, platformsDir, requested);
    const platformDir = join(platformsDir, platformId);
    mkdirSync(platformDir, { recursive: true });

    const paths: PlatformPaths = {
      dataRoot,
      platformsDir,
      platformId,
      platformDir,
      dbPath: join(platformDir, DATABASE_NAME),
      logPath: join(platformDir, 'server.log'),
    };
    await options.onResolved?.(paths);
    return paths;
  } finally {
    lock?.release();
  }
}

/**
 * An id names exactly one directory under `platforms/`. Anything that could
 * walk out of it (`/`, `\`, `.`, `..`) would break the layout every document
 * pins, so it is refused instead of being normalised behind the caller's back.
 */
function singleDirectoryName(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === '.' || raw === '..' || raw === START_LOCK_NAME || /[/\\\0]/.test(raw)) {
    throw new Error(
      `refusing to start: PIGROUPS_PLATFORM_ID must be a single directory name, got ${JSON.stringify(raw)}. ` +
        'It selects one directory under platforms/, so it cannot contain a path separator or name the ' +
        'platforms directory itself.',
    );
  }
  return raw;
}

/**
 * Resolves the platform id while the startup lock is held. A legacy root
 * database is only adopted when there is no platform yet; if there is one, the
 * caller has to say which database they mean.
 */
function choosePlatformId(dataRoot: string, platformsDir: string, requested: string | undefined): string {
  const legacyDbPath = join(dataRoot, DATABASE_NAME);
  const existing = listPlatformIds(platformsDir);

  if (existsSync(legacyDbPath)) {
    if (existing.length > 0) {
      const stranded = listHalfAdoptedIds(platformsDir);
      const strandedNote =
        stranded.length === 0
          ? ''
          : ` Note that ${stranded.join(', ')} hold${stranded.length === 1 ? 's' : ''} a sidecar of that ` +
            'database (-wal/-shm/-journal) without its database.';
      throw new Error(
        `refusing to start: there is an old database at ${legacyDbPath} and platforms/ already contains ` +
          `${existing.length === 1 ? 'a platform' : 'platforms'} (${existing.join(', ')}). ` +
          'Not guessing which database you want. Move pigroups.db (and pigroups.db-wal / pigroups.db-shm / ' +
          'pigroups.db-journal if present) into one platform directory under ' +
          `${platformsDir} first, or move it out of the data root.${strandedNote}`,
      );
    }

    const platformId = adoptionTarget(dataRoot, platformsDir, requested);
    adoptLegacyDatabase(dataRoot, join(platformsDir, platformId));
    return platformId;
  }

  if (requested !== undefined) return requested;
  if (existing.length === 1) return existing[0];
  if (existing.length === 0) return newPlatformId(platformsDir);

  throw new Error(
    `refusing to start: multiple platforms exist in ${platformsDir}: ${existing.join(', ')}. ` +
      'Set PIGROUPS_PLATFORM_ID to choose one.',
  );
}

/**
 * Where the legacy database should land. Normally that is a fresh id, but a
 * crash in the middle of an earlier adoption leaves the sidecars (which move
 * first) in a directory whose database is still at the root. Such a directory
 * is not a platform, yet it is the only place the newest committed rows can
 * live, so the adoption has to finish there instead of orphaning that WAL.
 */
function adoptionTarget(dataRoot: string, platformsDir: string, requested: string | undefined): string {
  const halfAdopted = listHalfAdoptedIds(platformsDir);
  if (halfAdopted.length === 0) return requested ?? newPlatformId(platformsDir);

  if (halfAdopted.length > 1) {
    throw new Error(
      `refusing to start: ${halfAdopted.length} directories under ${platformsDir} hold a database sidecar without ` +
        `its database (${halfAdopted.join(', ')}) and ${join(dataRoot, DATABASE_NAME)} is still at the data root. ` +
        'An earlier adoption was interrupted more than once. Decide which sidecar belongs to that database, ' +
        'delete the others by hand, then start again.',
    );
  }

  const target = halfAdopted[0];
  if (requested !== undefined && requested !== target) {
    throw new Error(
      `refusing to start: an earlier adoption was interrupted and left the sidecars of ${join(dataRoot, DATABASE_NAME)} ` +
        `in ${join(platformsDir, target)}, which is not the platform you asked for (${requested}). ` +
        `Start without PIGROUPS_PLATFORM_ID to finish that adoption, or remove ${join(platformsDir, target)} ` +
        'if you no longer need the rows that are only in its WAL.',
    );
  }
  return target;
}

/**
 * Moves the legacy root database into `platformDir`. Sidecars go first and the
 * main database last, so a half-finished move leaves the root database as the
 * marker that adoption is still required (and `adoptionTarget` finds the
 * sidecars it left behind). If a rename fails, the sidecars are put back and a
 * directory this call created is removed again.
 */
function adoptLegacyDatabase(dataRoot: string, platformDir: string): void {
  const created = !existsSync(platformDir);
  mkdirSync(platformDir, { recursive: true });
  const sourceDbPath = join(dataRoot, DATABASE_NAME);
  const moved: Array<{ from: string; to: string }> = [];

  try {
    for (const suffix of SIDECAR_SUFFIXES) {
      const from = `${sourceDbPath}${suffix}`;
      if (!existsSync(from)) continue;
      const to = join(platformDir, `${DATABASE_NAME}${suffix}`);
      renameSync(from, to);
      moved.push({ from, to });
    }
    renameSync(sourceDbPath, join(platformDir, DATABASE_NAME));
  } catch (error) {
    for (const { from, to } of moved.reverse()) {
      try {
        renameSync(to, from);
      } catch {
        // Best effort: the original error below is the actionable one.
      }
    }
    if (created) {
      try {
        rmdirSync(platformDir);
      } catch {
        // Not empty, so it is not ours to remove.
      }
    }
    throw adoptionError(error, dataRoot, platformDir);
  }
}

/** `EXDEV` is a layout mistake the operator can fix; a bare errno is not. */
function adoptionError(error: unknown, dataRoot: string, platformDir: string): Error {
  if (hasCode(error, 'EXDEV')) {
    return new Error(
      `refusing to start: ${join(dataRoot, DATABASE_NAME)} cannot be moved into ${platformDir} because the data ` +
        'root and its platforms/ directory live on different filesystems. Move the whole data root onto one ' +
        'filesystem, or move the old database into a platform directory yourself.',
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Directories without a database file are failed or empty leftovers, not platforms. */
function listPlatformIds(platformsDir: string): string[] {
  return readdirSync(platformsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && hasDatabaseFile(join(platformsDir, entry.name)))
    .map((entry) => entry.name)
    .sort();
}

/**
 * A directory holding only sidecars is the wreckage of an interrupted adoption:
 * `adoptLegacyDatabase` moves the sidecars first, so the database they belong to
 * is still at the data root.
 */
function listHalfAdoptedIds(platformsDir: string): string[] {
  return readdirSync(platformsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !hasDatabaseFile(join(platformsDir, entry.name)))
    .filter((entry) =>
      SIDECAR_SUFFIXES.some((suffix) =>
        existsSync(join(platformsDir, entry.name, `${DATABASE_NAME}${suffix}`)),
      ),
    )
    .map((entry) => entry.name)
    .sort();
}

/** `pigroups.db` must be readable as a file; a directory of that name is not a platform. */
function hasDatabaseFile(platformDir: string): boolean {
  try {
    return statSync(join(platformDir, DATABASE_NAME)).isFile();
  } catch {
    return false;
  }
}

function newPlatformId(platformsDir: string): string {
  for (;;) {
    const id = `p_${randomBytes(4).toString('hex')}`;
    if (!existsSync(join(platformsDir, id))) return id;
  }
}

interface StartLockHolder {
  pid: number;
  at: number;
}

/**
 * Serialises "look, then create or adopt" across processes. `wx` makes exactly
 * one process the creator. A holder whose process is still alive is honoured:
 * this startup is refused (not queued), because a second creator is the one
 * thing this file exists to prevent.
 */
function acquireStartLock(platformsDir: string): { release: () => void } {
  const lockPath = join(platformsDir, START_LOCK_NAME);
  const at = Date.now();
  const payload = JSON.stringify({ pid: process.pid, at });
  let fd: number | undefined;

  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    const holder = readStartLock(lockPath);
    if (!lockIsAbandoned(lockPath, holder)) throw lockRefusal(lockPath, holder);
    stealAbandonedLock(lockPath, holder);
    try {
      fd = openSync(lockPath, 'wx');
    } catch (retryError) {
      if (hasCode(retryError, 'EEXIST')) throw lockRefusal(lockPath, readStartLock(lockPath));
      throw retryError;
    }
  }

  if (fd === undefined) throw lockRefusal(lockPath, readStartLock(lockPath));

  try {
    writeFileSync(fd, payload);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // The write failure is the error worth reporting.
    }
    throw error;
  }
  closeSync(fd);

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        const current = readStartLock(lockPath);
        // Only the lock this call created may be removed: after a steal, the
        // file on disk can belong to the process that stole it.
        if (current === null || current.pid !== process.pid || current.at !== at) return;
        unlinkSync(lockPath);
      } catch {
        // Never mask the error that is unwinding through `finally`; an
        // unreleased lock ages out on its own.
      }
    },
  };
}

/**
 * Removes a lock whose holder is gone. The payload is re-read immediately
 * before the unlink so a lock that was replaced in the meantime is left alone;
 * POSIX has no compare-and-delete, so this narrows the window instead of
 * closing it.
 */
function stealAbandonedLock(lockPath: string, seen: StartLockHolder | null): void {
  const current = readStartLock(lockPath);
  const unchanged =
    current === null ? seen === null : seen !== null && current.pid === seen.pid && current.at === seen.at;
  if (!unchanged || !lockIsAbandoned(lockPath, current)) throw lockRefusal(lockPath, current);
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

/**
 * A parsed holder is abandoned only when its process is gone. Time alone never
 * expires a live lock: a slow `openDatabase` (large WAL recovery, a frozen
 * container) must not let a second process into the critical section. For an
 * empty or unparsable payload — the file exists but its writer died before
 * writing — only the file's own age can tell that apart from a process writing
 * right now, so that is the one case where the clock decides.
 */
function lockIsAbandoned(lockPath: string, holder: StartLockHolder | null): boolean {
  if (holder !== null) return !isProcessAlive(holder.pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs > START_LOCK_STALE_MS;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return true;
    throw error;
  }
}

function readStartLock(lockPath: string): StartLockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; at?: unknown };
    if (typeof parsed?.pid !== 'number' || typeof parsed?.at !== 'number') return null;
    return { pid: parsed.pid, at: parsed.at };
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
}

function lockRefusal(lockPath: string, holder: StartLockHolder | null): Error {
  const who = holder === null ? '' : ` (pid ${holder.pid})`;
  const since = holder === null ? '' : ` since ${new Date(holder.at).toISOString()}`;
  return new Error(
    `refusing to start: another process is initializing this data root${who}. ` +
      `The startup lock ${lockPath} has been held${since}. Wait for it to finish and try again.`,
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
