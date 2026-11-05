# PiGroups

A multi-agent collaboration platform: one member tree, one group per node, one
consume-on-read inbox, one opaque instruction channel.

- `docs/概念稿.md` — the concept. Authoritative.
- `docs/设计说明.md` — the implementation companion: tables, delivery semantics, 15 endpoints.
- `docs/参考/` — the original design conversation.

```bash
npm install
PIGROUPS_ADMIN_TOKEN=... npm run serve            # PORT=7717 PIGROUPS_DATA=./.pigroups
PIGROUPS_PLATFORM_ID=p_xxxxxxxx npm run serve     # when the root holds more than one platform
npm test                                          # black-box tests, each with its own data root
npm run typecheck
```

One data root holds every platform (`<PIGROUPS_DATA>/platforms/<id>/pigroups.db`); without
`PIGROUPS_PLATFORM_ID` the server reuses the only platform, or creates one in an empty root,
and refuses to start when the choice is ambiguous.

One platform is served by one process. The listening socket is the lock: the platform binds
before it opens the database, records the port it got in `platforms/<id>/endpoint.json`, and
exits `2` when another process already serves the same platform. `PORT` only seeds a platform
that has no endpoint record yet.

`AGENTS.md` holds the working rules: file ownership, the runtime contract, and
the isolation rule that the implementation and the test suite are written and
reviewed without either side seeing the other.

The Pi adapter and the project handoff live in `../pigroups-adapter` (see its `docs/handoff.md`).
