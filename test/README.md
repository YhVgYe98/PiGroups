# Test suite

Tests use `node:test`; `npm test` runs every `test/*.test.ts` file. The test files stay
grouped by subsystem, because one file often exercises one module across unit and
integration levels. The **type** organization is in the generated
[`CATALOG.md`](./CATALOG.md), one row per case.

## Types

| Type | Meaning |
| --- | --- |
| `unit` | One module or fake; no real platform process. |
| `contract` | Public wire/package contract: envelope, schema, version, limits. |
| `integration` | A real platform process, a real CLI, or several modules together. |
| `regression` | A guard for a named past incident or bug class. |
| `tooling` | Repository, package, and catalog checks. |
| `e2e` | Real pi/herdr (none in this repo yet; real-machine evidence lives in the handoff docs). |

## Find a case

```bash
rg 'poll' test/CATALOG.md                     # free text + the case titles
rg '^\| P-INT-' test/CATALOG.md                  # every integration case
rg 'P-INT-017' test/CATALOG.md                    # one catalog ID
node --test --test-name-pattern='poll' test/*.test.ts
```

The catalog's `File` column links to the exact declaration line.

## Add or change a case

`test/catalog.config.json` maps every `*.test.ts` file to a default type and area.
A file that mixes levels lists per-case overrides under `cases` (exact test title).
The catalog test fails if a test file is unclassified, an override no longer matches,
or `CATALOG.md` is stale.

```bash
npm run test:catalog        # regenerate test/CATALOG.md
npm run test:catalog:check  # non-zero if it is stale
```

Do not edit `CATALOG.md` by hand.
