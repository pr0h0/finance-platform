# Contributing

1. Read [AGENTS.md](AGENTS.md) (commands, architecture, rules) and the ADRs.
2. Use Docker only: `scripts/bun.sh`, `scripts/go.sh`, compose files. Bun for JS deps.
3. Before a PR: `scripts/bun.sh run typecheck`, `scripts/bun.sh run lint`, `scripts/bun.sh run test`,
   `scripts/go.sh vet ./...`, `scripts/go.sh test ./...` (with the dev stack up so DB tests run).
4. Money changes need a fixture in `packages/test-fixtures/conformance/` that both Go and TS pass.
5. Schema changes are new migrations (`YYYYMMDDHHMMSS_<module>_<desc>.sql`), never edits.
6. Update `docs/implementation-status.md` and `docs/api/openapi.yaml` with your change.

## Bank importers
Prefer declarative JSON templates (`import_templates`); code adapters go in `packages/bank-importers` and
must include docs, a schema version, **synthetic or sanitized** fixtures, and tests for parsing, errors,
duplicates, encodings, dates and currencies. Never commit real bank statements or personal data.

## Commits
Small, focused, conventional messages (`feat(transactions): …`, `fix(money): …`). By contributing you agree
your work is licensed under AGPL-3.0-only.
