# PiGroups

A multi-agent collaboration platform: one member tree, one group per node, one
consume-on-read inbox, one opaque instruction channel.

- `docs/概念稿.md` — the concept. Authoritative.
- `docs/设计说明.md` — the implementation companion: tables, delivery semantics, 15 endpoints.
- `docs/参考/` — the original design conversation.

```bash
npm install
PIGROUPS_ADMIN_TOKEN=... npm run serve   # PORT=7717 PIGROUPS_DATA=./.data
npm test                                  # 48 black-box tests
npm run typecheck
```

`AGENTS.md` holds the working rules: file ownership, the runtime contract, and
the isolation rule that the implementation and the test suite are written and
reviewed without either side seeing the other.

The Pi adapter and the project handoff live in `../pigroups-adapter` (see its `docs/handoff.md`).
