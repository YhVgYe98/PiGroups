import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_DATA_ROOT = './.pigroups';

const DATABASE_NAME = 'pigroups.db';

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
}

/**
 * One data root holds many platforms. The layout is always:
 *
 *   <dataRoot>/platforms/<platform_id>/pigroups.db
 *   <dataRoot>/platforms/<platform_id>/server.log
 *
 * `PIGROUPS_PLATFORM_ID` selects the id explicitly. Without it the server reuses
 * the only existing platform; an empty root is refused because there is no id
 * to name and no record to rendezvous on. The adapter always mints an id.
 *
 * The 0.2.0 layout (`pigroups.db` directly under `<dataRoot>`) is not adopted:
 * refusing is the only safe answer once the acceptance path is gone. The
 * operator moves the file (and its sidecars) into a platform directory by hand.
 */
export function resolvePlatform(options: ResolvePlatformOptions = {}): PlatformPaths {
  const dataRoot = resolve(options.dataRoot ?? (process.env.PIGROUPS_DATA || DEFAULT_DATA_ROOT));
  const platformsDir = join(dataRoot, 'platforms');
  mkdirSync(platformsDir, { recursive: true });

  const legacyDbPath = join(dataRoot, DATABASE_NAME);
  if (hasDatabaseFile(dataRoot)) {
    throw new Error(
      `refusing to start: ${legacyDbPath} uses the 0.2.0 layout. ` +
        `Move pigroups.db (and pigroups.db-wal / pigroups.db-shm / pigroups.db-journal if present) ` +
        `into a platform directory under ${platformsDir}/, then set PIGROUPS_PLATFORM_ID to that directory.`,
    );
  }

  const requested = singleDirectoryName(options.platformId ?? process.env.PIGROUPS_PLATFORM_ID);
  const existing = listPlatformIds(platformsDir);

  let platformId: string;
  if (requested !== undefined) {
    platformId = requested;
  } else if (existing.length === 1) {
    platformId = existing[0];
  } else if (existing.length === 0) {
    throw new Error(
      `refusing to start: no platform exists in ${platformsDir} and PIGROUPS_PLATFORM_ID is not set. ` +
        'Set PIGROUPS_PLATFORM_ID to the platform id this process should create.',
    );
  } else {
    throw new Error(
      `refusing to start: multiple platforms exist in ${platformsDir}: ${existing.join(', ')}. ` +
        'Set PIGROUPS_PLATFORM_ID to choose one.',
    );
  }

  const platformDir = join(platformsDir, platformId);
  mkdirSync(platformDir, { recursive: true });

  return {
    dataRoot,
    platformsDir,
    platformId,
    platformDir,
    dbPath: join(platformDir, DATABASE_NAME),
    logPath: join(platformDir, 'server.log'),
  };
}

/**
 * An id names exactly one directory under `platforms/`. Anything that could
 * walk out of it (`/`, `\`, `.`, `..`) would break the layout every document
 * pins, so it is refused instead of being normalised behind the caller's back.
 */
function singleDirectoryName(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === '.' || raw === '..' || /[/\\\0]/.test(raw)) {
    throw new Error(
      `refusing to start: PIGROUPS_PLATFORM_ID must be a single directory name, got ${JSON.stringify(raw)}. ` +
        'It selects one directory under platforms/, so it cannot contain a path separator or name the ' +
        'platforms directory itself.',
    );
  }
  return raw;
}

/** Directories without a database file are failed or empty leftovers, not platforms. */
function listPlatformIds(platformsDir: string): string[] {
  return readdirSync(platformsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && hasDatabaseFile(join(platformsDir, entry.name)))
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

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
