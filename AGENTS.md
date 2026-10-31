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
  - Listens on `PORT` (default `7717`).
  - Data directory from `PIGROUPS_DATA` (default `./.data`), created if missing.
  - Prints exactly one line to stdout when it is ready to accept requests: `listening on <port>`
  - On `SIGTERM` / `SIGINT`: stop accepting, close the DB, exit `0`.
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
- Do not rebase, amend, or force-push. Do not commit `node_modules/` or `.data/`.

## Behaviour

- Prefer the smallest change that satisfies the spec. No speculative abstractions, no new endpoints, no extra fields.
- When the spec is silent or looks wrong, stop and ask instead of guessing. The concept is a deliberate set of trade-offs; "improving" it silently is the one unacceptable outcome.
