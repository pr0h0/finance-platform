# Client data layer: storage, local mode, sync, E2EE

Packages: `@finplat/storage`, `@finplat/sync-client`, `@finplat/api-client`, `@finplat/localization`.
Server side of the protocol: [sync-protocol.md](sync-protocol.md). Key design: [ADR 0005](decisions/0005-e2e-encryption.md),
[ADR 0006](decisions/0006-local-persistence.md).

## Layers

```
web UI ──> DataSource (mode-agnostic)
             ├─ LocalDataSource   (local-only mode)      ┐
             └─ RemoteDataSource  (connected mode)       ├─> LocalFinanceService ──> LocalStore
                    └─ SyncEngine ──> api-client ──> /api/v1/sync/*            │   (IdbStore | MemoryStore
                                                                                │    | future SQLite)
```

* **LocalStore** (`storage/src/types.ts`): `run(mode, tables, fn)` = one atomic transaction; `get/put/delete/query`
  (`query` = profile-scoped range scan on a `[profileId, field]` index, tombstones hidden unless
  `includeDeleted`), `enqueue` (outbox). `IdbStore` (IndexedDB via `idb`) and `MemoryStore` (tests) have the
  same semantics and run the same test-suite. A Tauri/SQLite adapter (Phase 4) implements the same interface.
  IndexedDB caveat: `fn` must only await store calls (IndexedDB auto-commits when idle).
* **Schema** (`storage/src/schema.ts`): forward-only `MIGRATIONS` (tables + indexes + optional data step run in
  the upgrade transaction). Never edit a released version; append one. Tested with a v1→v2 fixture.
* **Quota**: `storageEstimate()`, `requestPersistence()`, `isLowOnSpace()`; IndexedDB `QuotaExceededError` is
  rethrown as `StorageQuotaError`; missing IndexedDB as `StorageUnavailableError`.
* **LocalFinanceService** (`storage/src/local/service.ts`): the REST operations on a LocalStore — generic CRUD for
  accounts, categories, tags, merchants, transaction/split templates, rules, budgets (+allocations), recurrences,
  plans (+occurrences), subscriptions, goals, contributions; transactions (posting/split derivation mirrors
  `apps/api/internal/transactions/service.go`: expense/income/refund/transfer/fx/opening balance, transfer fees as
  linked expenses, refunds pro rata and capped, adjustments, split templates, bulk edit, keyset search),
  imports (stage → preview with fp1 duplicate detection → commit with rules → scoped rollback; raw records
  immutable), attachments as Blobs, settings, dashboard layout, notifications, and engine calculations
  (balances, budget status, plan occurrences, goal progress). Validation uses `@finplat/validation` (+
  `local/schemas.ts` for inputs the API package does not cover yet). Errors are `ServiceError` with the same
  `{status, code, message, details}` as `ApiError`.
* Every synced mutation writes the row (version+1, `updatedAt`, tombstone on delete) **and** an outbox op
  (`opId` UUIDv7, `baseVersion`, full snapshot, `changedFields`) in the same transaction.

## Connected mode

`RemoteDataSource` = `LocalFinanceService` on a per-server cache store + one `SyncEngine` per profile; every
write schedules a debounced sync. Profiles are listed from the server and cached for offline use. Server-only
features (server analytics, MCP, devices, sessions) are called through `api-client` directly.

### SyncEngine (`sync-client/src/engine.ts`)
* `checkServer()` – `/api/v1/meta` + `checkCompatibility` before any data is sent (feature 107);
  `normalizeServerUrl()` accepts only https (http only for localhost).
* `push()` – outbox in order, batches (≤500), retry with exponential backoff + jitter for network/5xx/429.
  `applied` → ack (stamp `serverVersion` if the row is still that version); `conflict` → stored in `conflicts`
  and acked; `rejected` → kept in the outbox with `status: rejected` (dashboard) and never resent.
  A lost response is safe: the retry resends the same opIds and the server returns the stored results.
* `pull()` – by cursor; each page **and** the checkpoint commit in one store transaction (crash = re-pull one
  page; applying is idempotent). A row with unpushed local ops is never overwritten (no last-write-wins);
  older changes never overwrite newer ones; deletes become local tombstones; unknown entity types are skipped.
* `downloadSnapshot()` – initial download of current state, then pull from the snapshot head.
* `refreshConflicts()` / `resolve(id, server|client|merged)` – explicit resolution through the server.
* `status()` – last sync, last error, pending/rejected ops, open conflicts, checkpoint (feature 108).

### Activation, disconnect, server migration (`activation.ts`)
1. `previewActivation()` – counts to upload and duplicate candidates (accounts by name+currency, categories,
   tags, merchants, transactions by date/kind/description/amounts) against the server snapshot.
2. `activate({merge})` – one transaction: drop merged local duplicates and remap every reference to the
   server id, reset versions, replace the local-mode op history with one create per live row (parents first),
   then push in batches. State is persisted, so calling `activate()` again after an interruption resumes.
3. `verify()` – every uploaded row exists on the server and per-account balances match exactly; only then is
   `sync:config:<profile>.active = true`. A failed verification leaves sync inactive and local data untouched.
4. `disconnectPreview()` / `disconnect()` – reports unsynced changes, deactivates, keeps every local row and
   the outbox. Remote deletion is a separate explicit API call. Logout never deletes data.
5. **Server migration** (feature 109): disconnect from server A, `activate()` against server B (the whole
   current state is uploaded again with fresh versions). Export an encrypted backup first.

Not carried by sync (stay on the device): imported raw records and import batches (uploaded transactions
keep `source: import` but `importRecordId = null`), attachment contents.

## E2EE (`crypto.ts`, `e2ee.ts`) — ADR 0005
* libsodium (`libsodium-wrappers-sumo`): XChaCha20-Poly1305-IETF records, AAD =
  `profileId|entityType|entityId|keyId|1` (envelopes cannot be moved between rows); Argon2id passphrase KEK
  (MODERATE on web, parameters stored in the envelope); recovery code = 256 random bits shown once as 52
  Crockford-base32 characters (KEK via keyed BLAKE2b, deviation from the "24 words" in the ADR: no wordlist
  to ship and same entropy); device keys X25519 with `crypto_box_seal`.
* `enableE2ee()` uploads password, recovery and device envelopes to `/sync/keys`; `unlock()` with passphrase,
  recovery code or an enrolled device; `enrollDevice()` seals all generations to a new device;
  `rotateKey()` after revocation creates a new generation (old data stays readable, new writes use the new key;
  everything is re-wrapped for the new passphrase/recovery code). Data a revoked device already downloaded
  cannot be recalled.
* The engine encrypts every payload before push and decrypts after pull; `changedFields` are not sent
  (metadata), so every stale edit becomes a conflict resolved on a client.
* **Limitations**: the device private key and unlocked keyring live in browser storage (IndexedDB `meta`),
  which is not a secure enclave; the local database itself is not encrypted at rest. The app lock
  (`hashLockSecret`/`verifyLockSecret`, Argon2id) gates the UI only. Lose passphrase + recovery code + all
  enrolled devices = data unrecoverable. Server-side analytics/MCP are unavailable for e2ee profiles.

## Encrypted backups
Format: [backup-format.md](backup-format.md). `exportBackup(store, passphrase)`, `importBackup(store, file,
passphrase, {overwrite})`, `readBackupHeader(file)`. Restored profiles are local-only until sync is activated.

## Localization
`@finplat/localization`: i18next with `en` (source) and `bs` (skeleton, falls back to en); `t(key, locale,
vars)`, `createI18n(locale)` for React bindings, `errorMessage(code)`. Formatting never uses floats for money:
`formatMoney`, `formatDecimal` take the Intl pattern from a placeholder and the digits from the decimal string;
`formatDate` renders `YYYY-MM-DD` without timezone shift; `parseDecimalInput` reads localized input.

## Tests
```sh
scripts/bun.sh test packages/storage packages/sync-client packages/api-client packages/localization
# against the real dev API (two devices, push/pull, tombstones):
sg docker -c "docker compose -f docker-compose.dev.yml up -d"
sg docker -c "docker run --rm --user 1000:1000 --network finplat-dev_default -v $PWD:/repo -w /repo \
  -v finplat_bun:/cache/bun -e BUN_INSTALL_CACHE_DIR=/cache/bun -e HOME=/tmp \
  -e FINPLAT_API_URL=http://api:8080 oven/bun:1.4 bun test packages/sync-client/src/real-server.test.ts"
```
The mocked server (`sync-client/src/fake-server.test-util.ts`) implements push/pull/snapshot/conflicts/keys
with the protocol's merge rules and failure injection (network down, lost responses).
