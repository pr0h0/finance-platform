# Sync protocol v1

Wire types: `packages/domain/src/sync.ts` (TS), OpenAPI tag `sync`. Server: `apps/api/internal/sync`
(endpoints) + `apps/api/internal/changes` (change log, used by every module).

## Concepts
| term | meaning |
|---|---|
| profile | unit of sync and authorization; all synced rows have `profile_id` |
| `server_version` | per-profile, strictly increasing integer. Allocated by `UPDATE profiles SET sync_version = sync_version + 1 … RETURNING` inside the writing DB transaction. The profile row lock serializes writers per profile, so a reader never sees version N+1 committed before N. |
| `version` | per-entity optimistic-concurrency counter; +1 per accepted update |
| op | a client mutation with a UUIDv7 `opId`, created offline |
| tombstone | `deleted_at` set + a `delete` change. Rows are never hard-deleted while syncable. |
| checkpoint | `sync_checkpoints(device, profile).last_pulled_version` (server) mirrored by the client store |

## Every server-side mutation (REST, MCP, import, sync push)
Inside one `pgx.Tx`:
1. write the entity row(s) (`version = version + 1` on update, `deleted_at = now()` on delete);
2. `changes.Record(ctx, tx, changes.Change{ProfileID, EntityType: "<table>", EntityID, Op, Data: <API shape>, Before, Action, OpID})`.

`Record` stamps `server_version` on the row, appends `sync_changes` and `audit_log`. Child rows
(postings, splits, tags) are carried inside the parent's `Data` snapshot (the transaction is the sync unit
for its postings/splits/tag links); they do not get separate changes. Tables without `server_version`
(audit_log, sessions …) are not synced.

## Push — `POST /api/v1/sync/push`
Request `{protocolVersion: 1, deviceId, profileId, operations[≤500]}`; operations applied **in order**,
each in its own DB transaction:
1. `opId` already in `sync_operations` → return the stored result (idempotent retry).
2. Validate exactly like the REST endpoint for that entity (same service function — sync must not be a
   back door). Authorization: editor role on the profile.
3. Create (`baseVersion = null`): insert with the client id. If the id exists with identical content →
   applied; otherwise rejected `id_conflict`.
4. Update: if `baseVersion == current version` → apply. If stale → **merge rule**:
   - compute fields changed on the server since `baseVersion` (from `sync_changes` snapshots) vs the op's
     `changedFields`;
   - disjoint and none is money-bearing → apply client fields on top of server state (field-level merge);
   - otherwise → insert `sync_conflicts` (server + client data, fields), result `conflict`; nothing applied.
5. Delete: tombstone; deleting an already-deleted row is applied (idempotent). Delete vs concurrent edit of
   money-bearing fields → conflict.
6. Store result in `sync_operations`.

**Money-bearing fields** (never auto-merged, never last-write-wins): postings (amount, currency,
account), transaction `kind`, `bookingDate` of imported transactions, splits (the split set is replaced
atomically and must still sum to the total — a merge that would break the sum is a conflict), plan/budget/
goal amounts, exchange-rate values, contribution amounts. Metadata (description, notes, tags, color, icon,
names, merchant, category of a single split) merges field-wise.

Response `{results: [{opId, status: applied|conflict|rejected, …}], serverVersion}`. A rejected op does
not stop later ops; clients keep rejected ops visible in the sync dashboard.

### Server implementation (apps/api/internal/sync)
- A module makes its table pushable with `sync.RegisterEntity("<table>", sync.Entity{Load, Upsert, Delete,
  MoneyFields})` from its `Register`. `Upsert`/`Delete` are the module's REST service functions (same
  validation) and call `changes.Record(..., OpID)`; `Load` returns the API snapshot, which must contain the
  integer `version`. Unregistered entity types are rejected with `unsupported_entity`.
- Each op runs in its own DB transaction with a savepoint: rejected ops leave no partial writes and their
  result is stored under the opId; transient server errors return `rejected/retry` and are NOT stored, so the
  client retries the same op. An opId already used by another profile is rejected (`op_id_conflict`).
- Stale-base merge: the base snapshot is the newest `sync_changes` upsert whose `data.version = baseVersion`
  (missing → conflict). Server-changed fields = diff(base, current) ignoring `version`, `serverVersion`,
  `updatedAt`; client-changed fields = `changedFields` or diff(base, client data). Overlap, or any
  client-changed money field, → conflict; otherwise merged = current + client fields, applied through
  `Upsert` (so split totals are re-validated).
- Push requires editor role, a human session and an active device of the caller (`deviceId`); the pushing
  device is recorded on every change.

## Pull — `GET /api/v1/sync/pull?since=N&limit≤1000`
Returns changes with `server_version > N` ascending, `nextSince`, `hasMore`, current head. Client applies
them transactionally in its store, then persists the checkpoint (crash between = re-pull, applying is
idempotent because snapshots are full entity states keyed by id + serverVersion). Changes the client itself
pushed (same `opId`) are acknowledged, not re-applied as remote edits.

Initial download / large history: `GET /api/v1/sync/snapshot` pages current state (not history); then pull
from the snapshot's head.

## Conflicts
`GET /sync/conflicts`, `POST /sync/conflicts/{id}/resolve` with `choice: server|client|merged` (+data). The
resolution is a normal mutation (validated, recorded, audited). Original data on both sides is preserved in
the conflict row.

## Compatibility
`GET /api/v1/meta` returns `apiVersion`, `schemaVersion`, `syncProtocolVersion`. Clients refuse to sync on a
different protocol major version (`@finplat/api-client.checkCompatibility`). Payload `data` snapshots are
the API entity shapes; additive fields are allowed, removals require a protocol bump.

## E2EE profiles
Stored in `encrypted_records` (profile, entityType, entityId, envelope, version, deleted_at). Push data must
be exactly `{v:1, alg:"xchacha20poly1305-ietf", keyId, nonce(24 bytes b64), ct(b64)}`; pulled `data` is that
envelope plus `version`. Audit entries carry metadata only. Wrapped profile keys: `GET/POST /sync/keys`.
`data` is an encryption envelope (ADR 0005); the server cannot merge, so any stale-base update to an e2ee
entity becomes a conflict resolved on a client.

## Activation / deactivation
Follows PLAN §21: upload in recoverable batches (ops with stable opIds, so an interrupted upload resumes),
verify by comparing per-account balances and counts after the pull, mark active only after verification.
Logout never deletes local data; remote deletion is a separate explicit action.
