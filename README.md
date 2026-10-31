# PiGroups

A multi-agent collaboration platform: one member tree, one group per node, one
consume-on-read inbox, one opaque instruction channel.

- `docs/概念稿.md` — the concept. Authoritative.
- `docs/设计说明.md` — the implementation companion: tables, delivery semantics, 15 endpoints.
- `docs/参考/` — the original design conversation.

```bash
npm install
npm run serve        # PORT=7717 PIGROUPS_DATA=./.data
npm test
npm run typecheck
```
