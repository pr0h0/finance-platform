# Encrypted backup file format (v1)

Implementation: `packages/sync-client/src/backup.ts`. One file, same format for local-only and connected
profiles. The passphrase never leaves the device. Suggested extension: `.finplat-backup`.

```
"FINPLAT-BACKUP\n"                       15 bytes, magic
<header JSON, UTF-8, no newlines> "\n"   plaintext, authenticated (see below)
<secretstream header>                    24 bytes (crypto_secretstream_xchacha20poly1305)
repeat:  <u32 big-endian length> <ciphertext chunk>   plaintext chunks of 64 KiB, last tagged FINAL
```

Header:

| field | meaning |
|---|---|
| `format_version` | 1. Readers refuse newer versions. |
| `schema_version` | local store schema the payload was written with; restore refuses newer ones |
| `alg` | `xchacha20poly1305-secretstream` (libsodium) |
| `kdf`, `kdf_params` | `argon2id13`, `{opslimit, memlimit}` (default MODERATE) |
| `salt` | base64, 16 bytes |
| `created_at` | RFC 3339 |

Key = Argon2id(passphrase NFKC, salt, params), 32 bytes. The header JSON bytes are the additional data of
the first chunk, so changing any header field (e.g. lowering KDF cost) makes decryption fail. A missing FINAL
tag (truncated file), any modified byte, data after FINAL or a wrong passphrase are all rejected.

Plaintext = UTF-8 JSON:

```json
{
  "format": "finplat-backup", "formatVersion": 1, "schemaVersion": 1, "exportedAt": "…",
  "profiles": [Profile…],
  "tables": { "accounts": [ … ], "transactions": [ … ], … },
  "blobs": [ { "id": "<attachment id>", "profileId": "…", "type": "image/png", "data": "<base64>" } ]
}
```

Rows use the API wire shapes (`@finplat/domain`), money as `{amount: decimal string, currency}`; tombstones
are included. Tables: all synced entity tables plus `exchange_rates`, `imported_raw_records` (immutable import
evidence), `notifications`, `settings`. Not included on purpose: sync outbox, checkpoints, conflicts, device
keys and E2EE keyrings (a backup restored elsewhere starts as a local-only profile; re-activate sync to upload).

Restore (`importBackup`) writes everything in one transaction; profiles that already exist are refused unless
`overwrite` is set (their local rows are replaced). Unknown tables from a newer minor writer are ignored.
