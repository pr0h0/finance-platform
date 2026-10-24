# Export / backup format (Feature 94) and server migration (Feature 109)

`GET /api/v1/export` (header `X-Profile-ID`) returns one JSON document; a server backup
(`POST /api/v1/backups`, `GET /api/v1/backups/{id}/download`) is the same document gzip-compressed.

```jsonc
{
  "format": "finplat-export",
  "formatVersion": 2,                   // 2 added "files"; version 1 documents are still restored
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
  ],
  "files": [                            // content of every live (not deleted) attachment row
    { "attachmentId": "…", "mimeType": "image/jpeg", "sha256": "<hex of the content>", "data": "<base64>" }
  ]
}
```

- Money columns are decimal strings/numbers exactly as stored (`NUMERIC`), never floats in the source.
- Not included: audit history, sync bookkeeping (operations, checkpoints, conflicts), MCP grants, E2EE key
  envelopes, sessions.
- Attachment contents are in `files` (plaintext, server-side `ATTACHMENT_ENCRYPTION_KEY` undone). E2EE profiles
  have no contents on the server (they stay on devices and in the client's encrypted backup), so `files` is
  empty; an attachment row whose content is missing on the server is exported without a file.
- Size: the export is built in memory (contents plus their base64), so it is about 1.4x the attachments'
  total size; a restore upload is limited by `MAX_UPLOAD_BYTES` (default 25 MiB) — raise it on the target
  server when migrating a profile with many attachments.
- The web app's "Export from this device" writes the same envelope (`source: "device"`, tables keyed by the
  device's table names with camelCase fields) with `files` for the attachments stored on that device.
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
- each file is checked against its `sha256` (and the row's) and written to the attachment storage under the
  new profile/attachment id (encrypted at rest when the target has `ATTACHMENT_ENCRYPTION_KEY`; type re-sniffed
  against the upload allowlist); a mismatch refuses the restore (`422`). Rows without a file (version 1
  documents) get a **copy** of the original's content (never a shared key) when that attachment still exists on
  this server in a profile the restoring user is a member of; otherwise they keep metadata only;
- users referenced by the backup that do not exist on this server are replaced by the restoring user;
- the sync log is rebuilt from the snapshots (`changes.Record`), so connected devices download the profile;
- a backup from a newer schema is refused (`409 backup_newer_than_server`).

## Migrating to another server
1. On the old server: `GET /api/v1/export` for each profile (or download a backup).
2. On the new server: register/log in, `POST /api/v1/backups/restore` with the file.
3. Point clients at the new backend URL (they verify `/api/v1/meta` compatibility). Clients keep their local
   data when disconnecting; nothing is deleted automatically on either server.
4. Delete the profile on the old server explicitly (`DELETE /api/v1/profiles/{id}`) once verified.
