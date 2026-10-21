# Architecture decision records

| ADR | Decision |
|---|---|
| [0001](0001-stack.md) | Stack: Go + chi + pgx + goose, PostgreSQL, React/Vite/TS/Tailwind, Bun, Docker |
| [0002](0002-money-representation.md) | Money = decimal string at currency scale + ISO code; bigint/math/big arithmetic |
| [0003](0003-ledger-model.md) | Ledger: transaction header + immutable postings + category splits; immutable import evidence |
| [0004](0004-sync-protocol.md) | Op-log sync with per-profile server_version; no LWW for money |
| [0005](0005-e2e-encryption.md) | E2EE design: XChaCha20-Poly1305, Argon2id, envelope keys, two privacy modes |
| [0006](0006-local-persistence.md) | Local persistence behind `LocalStore` (IndexedDB web, SQLite native) |
| [0007](0007-license.md) | AGPL-3.0-only |
| [0008](0008-module-layout.md) | Backend module layout, route ownership, migration naming |

New ADR: copy the format (Context / Decision / Consequences), next number, link it here.
