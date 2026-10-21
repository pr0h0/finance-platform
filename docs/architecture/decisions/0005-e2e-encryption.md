# 0005 — End-to-end encryption design

Status: accepted as design (Phase 0). Implementation and key-lifecycle tests are required before the
feature is called production-ready (Feature 88).

## Two explicit privacy modes (per profile, `profiles.privacy_mode`)
1. **`server_readable`** (default for connected mode): data is protected in transit (TLS) and at rest by
   the operator's disk encryption; the server can compute analytics, forecasts, MCP answers. The UI must
   say plainly this is **not** end-to-end encrypted.
2. **`e2ee`** (private encrypted sync): the server stores ciphertext envelopes only. All calculations,
   search, analytics and AI/MCP analysis happen on authorized clients after decryption. Remote MCP
   (server-side) is unavailable for e2ee profiles; only the future local MCP can serve them.

Switching server_readable → e2ee re-uploads encrypted copies then purges plaintext rows (explicit, audited);
e2ee → server_readable uploads plaintext after explicit consent.

## Primitives (established libraries only)
- Library: **libsodium** (`libsodium-wrappers-sumo` in TS; Go server never decrypts). WebCrypto is used only
  for randomness where libsodium is unavailable.
- Record encryption: **XChaCha20-Poly1305 IETF** (24-byte random nonce, no nonce-reuse risk), AAD =
  `profileId | entityType | entityId | keyId | schemaVersion` so ciphertexts cannot be swapped between rows.
- Key derivation from passphrase: **Argon2id** (`crypto_pwhash`, OPSLIMIT_MODERATE/MEMLIMIT_MODERATE on web;
  parameters stored with the envelope so they can be raised later).
- Device keys: X25519 key pair per device (`devices.public_key`); key wrapping via `crypto_box_seal`.
- Hashing for fingerprints: BLAKE2b (`crypto_generichash`).

## Key hierarchy
- **Profile Data Key (PDK)**: random 256-bit, one per profile per generation (`key_id`).
- PDK is stored only wrapped, in `key_envelopes`:
  - `password`: wrapped with KEK = Argon2id(passphrase, salt).
  - `recovery`: wrapped with KEK derived from a **recovery code** (24 random words / 256-bit, shown once,
    printable). Lose passphrase + recovery code = data is unrecoverable (stated in UI).
  - `device`: sealed to each enrolled device's public key.
  - `member`: sealed to a household member's device keys (shared profiles).
- **Device enrollment**: new device shows a pairing code; an existing device verifies it and seals the PDK
  to the new device public key (or the user enters the passphrase / recovery code).
- **Rotation / revocation**: revoking a device or member creates a new PDK generation, re-encrypts records
  lazily (new writes use new key; background re-encryption job on a trusted client), and marks old
  envelopes `revoked_at`. Data the revoked party already downloaded cannot be recalled (documented).

## Envelope format (sync_changes.data, attachments, backups)
`{ "v": 1, "alg": "xchacha20poly1305-ietf", "keyId": "...", "nonce": b64, "ct": b64 }`.

## Encrypted backups
File = header JSON (`format_version`, `schema_version`, `kdf`, `kdf_params`, `alg`, salt) + XChaCha20-Poly1305
secretstream chunks of the export JSON. Same format for local-only and server backups; server never sees the
passphrase. `encrypted_backups.encryption` stores only parameters.

## Metadata exposure (e2ee mode)
Visible to the server: user/profile/device ids, entity type, entity id, server_version, timestamps, sizes,
op ids, household membership, attachment sizes. Hidden: amounts, dates, descriptions, categories, merchants,
account names, file contents. Search/analytics/import parsing run client-side.

## Consequences
Server-side features (forecast API, analytics API, remote MCP, server import parsing) check
`privacy_mode` and return 409 `e2ee_profile` for e2ee profiles.
