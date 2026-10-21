# Export / backup format (Feature 94) and server migration (Feature 109)

`GET /api/v1/export` (header `X-Profile-ID`) returns one JSON document; a server backup
(`POST /api/v1/backups`, `GET /api/v1/backups/{id}/download`) is the same document gzip-compressed.

```jsonc
{
  "format": "finplat-export",
  "formatVersion": 1,
  "schemaVersion": 20261021120000,      // highest migration applied on the exporting server
  "exportedAt": "2026-10-21T12:00:00Z",
  "profile": { "id": "…", "name": "Personal", "base_currency": "BAM", … },   // profiles row
  "settings": { … },                    // profile settings object
  "tables": {                           // every row of every table with a profile_id column,
    "accounts": [ { "id": "…", "profile_id": "…", … } ],   // tombstoned rows included,
    "transactions": [ … ], "postings": [ … ], …            // column names as in the database
  },
  "snapshots": [                        // latest synced API state per entity (sync_changes)
    { "entityType": "transactions", "entityId": "…", "serverVersion": 42, "data": { … } }
  ]
}
```

- Money columns are decimal strings/numbers exactly as stored (`NUMERIC`), never floats in the source.
- Not included: audit history, sync bookkeeping (operations, checkpoints, conflicts), MCP grants, E2EE key
  envelopes, sessions, attachment **file contents** (attachment metadata rows are included).
- The export is read in one REPEATABLE READ snapshot, so it is internally consistent.

## Server backups
- Stored in `BACKUP_DIR/<id>.fpb`. With `BACKUP_ENCRYPTION_KEY` (base64 of 32 random bytes) the file is
  `FPB1 | nonce(12) | AES-256-GCM(gzip(export))` with the backup id as AAD; otherwise plain gzip, and
  `encryption.alg = "none"` says so. Metadata (`encrypted_backups.encryption`) never contains key material.
- Download verifies the sha256 and decrypts on the server; the user receives the gzip export.
- Scheduled: every live profile is backed up every `BACKUP_SCHEDULE` (Go duration, `off` disables; needs
  `JOBS_ENABLED=true`); scheduled backups older than `BACKUP_RETENTION_DAYS` are deleted.
- Losing `BACKUP_ENCRYPTION_KEY` makes encrypted server backups unreadable; keep it with the server secrets.
- E2EE profiles: the server only holds ciphertext envelopes; passphrase-encrypted backups are made by a client
  (ADR 0005). Server-side restore of an e2ee export is refused (`409 e2ee_profile`) because ciphertext is
  bound to its ids via AAD.

## Restore
`POST /api/v1/backups/restore` (multipart: `file`, optional `targetProfileId`):
- without `targetProfileId` a new profile "<name> (restored)" is created; with it, the target must be a
  profile you own that has no data (a pre-restore backup of it is taken first);
- every row gets a **new id** (all references, including ids inside JSON columns and snapshots, are remapped),
  so a backup can be restored next to its original or on a different server;
- users referenced by the backup that do not exist on this server are replaced by the restoring user;
- the sync log is rebuilt from the snapshots (`changes.Record`), so connected devices download the profile;
- a backup from a newer schema is refused (`409 backup_newer_than_server`).

## Migrating to another server
1. On the old server: `GET /api/v1/export` for each profile (or download a backup).
2. On the new server: register/log in, `POST /api/v1/backups/restore` with the file.
3. Point clients at the new backend URL (they verify `/api/v1/meta` compatibility). Clients keep their local
   data when disconnecting; nothing is deleted automatically on either server.
4. Delete the profile on the old server explicitly (`DELETE /api/v1/profiles/{id}`) once verified.
