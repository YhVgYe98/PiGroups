# PiGroups — working rules

Read before writing anything:

- `docs/概念稿.md` — the concept. **Authoritative.** Where it disagrees with anything else, it wins.
- `docs/设计说明.md` — the implementation companion: tables, delivery semantics, the 15 endpoints, error codes, transaction boundaries.

There is no other spec. If something you need is not in those two files, ask; do not invent it.

## Language

Documents are Chinese. Code, comments, commit messages, test names, and anything you write into the repo are English.

## Runtime contract — do not change

- Node >= 24, ESM, TypeScript run directly (Node strips types; **there is no build step**).
- SQLite through the built-in `node:sqlite` (`DatabaseSync`). No better-sqlite3, no native modules, no ORM.
- HTTP through `hono` + `@hono/node-server`.
- `npm run serve` → `node src/main.ts`
  - Listens on `PORT` (default `7717`). `PORT` is only the *first candidate*: an existing
    platform starts from the port in its own `endpoint.json`, and an occupied candidate moves
    to the next port when the holder identifies itself as something else (design §11.0).
  - Data root from `PIGROUPS_DATA` (default `./.pigroups`), created if missing.
  - **One data root holds every platform.** The database is
    `<PIGROUPS_DATA>/platforms/<platform_id>/pigroups.db`, pinned by `docs/设计说明.md` §11.
    A test that needs the file asks `GET /v1/health` for `platform_id` first; it never guesses the name.
  - `PIGROUPS_PLATFORM_ID` selects the platform. Without it the server reuses the only one,
    creates one in an empty root, and refuses to start when the choice is ambiguous.
    A platform is a directory under `platforms/` that holds a `pigroups.db` **file**; an empty
    directory is not one. An explicit id is used verbatim and must be a single directory name
    (`/`, `\`, `.`, `..` and the lock file name are refused).
  - A data root that still has the 0.2.0 layout (`<PIGROUPS_DATA>/pigroups.db`) is adopted once
    at startup, but only when `platforms/` is still empty: the file and its `-wal`/`-shm`/`-journal`
    move into a platform directory (the explicit id if one was given, otherwise a fresh one).
    A root database next to an existing platform refuses to start, even with an explicit id.
  - Startup takes `<PIGROUPS_DATA>/platforms/.start.lock` while it looks for a platform and
    opens the database. A concurrent start in the same root whose holder is still alive is
    refused immediately (not queued). The lock picks an id, adopts a legacy database, and
    covers the first start of a platform that has no endpoint record yet (two starters with
    different PORT values would otherwise bind different ports and open one database). A
    platform that already has a record skips the lock: its port is the rendezvous. The lock
    is not the runtime single-instance check.
  - The listener is bound *before* the database is opened, and held for the life of the
    process: the bind is the single-instance lock. `platforms/<id>/endpoint.json` records
    `{platform_id, port, version, pid, updated_at}` right after the bind, and is the address a
    client or a later start uses. It is a hint, not proof of ownership.
  - A candidate held by the same platform exits `2` without touching data. Every other outcome
    (another platform, a non-PiGroups service, a refused connection, a timeout) gets a second
    probe, and two probes that do not name this platform move to the next port. A bound
    platform blocked opening its database cannot answer, so its own endpoint record — written
    before that open — supplies the same `platform_id` and port and still exits `2`.
  - Before the database is open, `GET /v1/health` answers `503 {status:'starting', version,
    platform_id}` so a competing start can still identify the instance.
  - Prints exactly one line to stdout when it is ready to accept requests: `listening on <port>`
  - On `SIGTERM` / `SIGINT`: stop accepting, close the DB, exit `0`.
  - `PIGROUPS_ADMIN_TOKEN`, when set, is read from the environment. `POST /v1/humans` requires it
- `npm test` → `node --test test/*.test.ts`
- `npm run typecheck` → `tsc --noEmit`

`package.json`, `tsconfig.json`, `AGENTS.md`, `README.md`, and `docs/**` are owned by the boss. Do not edit them. Need a dependency or a script? Ask.

## File ownership — hard rule

| Path | Owner |
|---|---|
| `src/**` | the implementation worker |
| `test/**` | the test worker |

## Isolation — hard rule

The implementation worker and the test worker must never read each other's work.

- Implementation worker: do not read, list, glob, or grep `test/**`.
- Test worker: do not read, list, glob, or grep `src/**`.
- Neither reads the other's output, reports, or commit diffs.
- Everything one needs to know about the other arrives **in words, from the boss**.

Both may read `docs/**`, `package.json`, and this file. The 15 endpoints, request/response fields, and error codes are all specified in `docs/设计说明.md` §10 — that is the test worker's source of truth.

## Git

- Commits are made **unsigned**: this repository has `commit.gpgsign=false` and `tag.gpgsign=false` locally. Always commit as `git commit --no-gpg-sign -m "..."` so it stays explicit; never add `-S`.
- One commit per task. Message: `area: what changed` (for example `src: poll cursor and gap folding`).
- Do not rebase, amend, or force-push. Do not commit `node_modules/`, `./.pigroups/`, or a
  leftover `./.data/` root from 0.2.0.
- Commit only the paths you own: `git add src/` or `git add test/`. **Never** `git add -A` or `git add .` while another worker is writing in the same tree — it will sweep their half-finished files into your commit.

## Behaviour

- Prefer the smallest change that satisfies the spec. No speculative abstractions, no new endpoints, no extra fields.
- When the spec is silent or looks wrong, stop and ask instead of guessing. The concept is a deliberate set of trade-offs; "improving" it silently is the one unacceptable outcome.
