import pkg from '../package.json' with { type: 'json' };

/**
 * Reported by `GET /v1/health` and as `server_version` on every response.
 * `package.json` is the only place the number is written; there is no second
 * constant to keep in sync.
 */
export const SERVER_VERSION: string = pkg.version;
