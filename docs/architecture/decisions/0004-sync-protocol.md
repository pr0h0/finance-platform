# 0004 — Synchronization protocol

Status: accepted (Phase 0). Full spec: [../sync-protocol.md](../sync-protocol.md).

## Decision
Operation-log sync. Clients create ops offline (UUIDv7 `opId`) and push them; the server applies each op
transactionally, records it in `sync_changes` with a per-profile, strictly increasing `server_version`, and
clients pull everything after their cursor. Idempotency by `opId` (`sync_operations`). Concurrency by
entity `version` (optimistic). Metadata fields merge when non-overlapping; money-bearing fields
(postings, amounts, splits, account, dates of postings) never merge silently — a conflict is created for
explicit resolution. Deletes are tombstones.

## Rejected
Last-write-wins row replication (PLAN §21 forbids it for money); CRDTs (overkill, hard to keep ledger
invariants); server-assigned ids only (breaks offline creation).
