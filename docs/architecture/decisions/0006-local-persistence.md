# 0006 — Local persistence abstraction

Status: accepted (Phase 0)

## Decision
`packages/storage` defines `LocalStore` (transactional `run(mode, tables, fn)`, `get/put/query`, sync
outbox, checkpoint). Implementations:
- **Web**: IndexedDB (versioned `onupgradeneeded` migrations; one object store per entity table with
  `profileId` + date indexes; `outbox` and `checkpoints` stores). Implemented in Phase 2.
- **Desktop/mobile**: SQLite via Tauri plugin (DEFERRED_TO_PHASE 3/4), same interface.

Local records use the same wire shapes as the API (`@finplat/domain`) so sync is a straight copy.
Local-only mode uses the same store with no server; all calculations come from `@finplat/finance-engine`.

## Consequences
Business logic never touches IndexedDB directly. A local store has its own `schemaVersion` independent of
the server schema; migrations must be forward-only and tested with stored fixtures.
