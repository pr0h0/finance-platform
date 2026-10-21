// Encrypted local backup: one self-contained, versioned file (format: docs/architecture/backup-format.md).
// Same format for local-only and connected profiles; the passphrase never leaves the device.
import type { Profile } from '@finplat/domain';
import { type LocalStore, SYNCED_TABLES } from '@finplat/storage';
import sodium from 'libsodium-wrappers-sumo';
import {
  defaultKdf,
  deriveKek,
  fromBase64,
  type KdfParams,
  newSalt,
  ready,
  toBase64,
} from './crypto.ts';

export const BACKUP_MAGIC = 'FINPLAT-BACKUP\n';
export const BACKUP_FORMAT_VERSION = 1;
const CHUNK = 64 * 1024;

/** Tables in a backup (sync state, outbox, conflicts and device keys are deliberately excluded). */
export const BACKUP_TABLES = [
  ...SYNCED_TABLES,
  'exchange_rates',
  'imported_raw_records',
  'notifications',
  'settings',
] as const;

export interface BackupHeader {
  format_version: number;
  schema_version: number;
  alg: 'xchacha20poly1305-secretstream';
  kdf: 'argon2id13';
  kdf_params: { opslimit: number; memlimit: number };
  salt: string;
  created_at: string;
}

interface Payload {
  format: 'finplat-backup';
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  profiles: Profile[];
  tables: Record<string, Record<string, unknown>[]>;
  blobs: { id: string; profileId: string; type: string; data: string }[];
}

export class BackupError extends Error {
  override name = 'BackupError';
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function exportBackup(
  store: LocalStore,
  passphrase: string,
  opts: { profileIds?: string[]; kdf?: Omit<KdfParams, 'salt'>; now?: () => Date } = {},
): Promise<Uint8Array> {
  await ready();
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const raw = await store.run('readonly', ['profiles', 'blobs', ...BACKUP_TABLES], async (tx) => {
    const profiles = (await tx.query<Profile>('profiles', {})).filter(
      (p) => !opts.profileIds || opts.profileIds.includes(p.id),
    );
    const tables: Payload['tables'] = {};
    const blobs: { id: string; profileId: string; blob: Blob }[] = [];
    for (const p of profiles) {
      for (const t of BACKUP_TABLES) {
        tables[t] ??= [];
        tables[t].push(
          ...(await tx.query<Record<string, unknown>>(t, {
            profileId: p.id,
            includeDeleted: true,
          })),
        );
      }
      blobs.push(
        ...(await tx.query<{ id: string; profileId: string; blob: Blob }>('blobs', {
          profileId: p.id,
        })),
      );
    }
    return { profiles, tables, blobs };
  });
  const payload: Payload = {
    format: 'finplat-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: store.schemaVersion,
    exportedAt: now,
    profiles: raw.profiles,
    tables: raw.tables,
    blobs: await Promise.all(
      raw.blobs.map(async (b) => ({
        id: b.id,
        profileId: b.profileId,
        type: b.blob.type,
        data: toBase64(new Uint8Array(await b.blob.arrayBuffer())),
      })),
    ),
  };
  const kdf = opts.kdf ?? defaultKdf();
  const header: BackupHeader = {
    format_version: BACKUP_FORMAT_VERSION,
    schema_version: store.schemaVersion,
    alg: 'xchacha20poly1305-secretstream',
    kdf: 'argon2id13',
    kdf_params: { opslimit: kdf.opslimit, memlimit: kdf.memlimit },
    salt: newSalt(),
    created_at: now,
  };
  const headerBytes = enc.encode(JSON.stringify(header));
  const key = deriveKek(passphrase, { alg: 'argon2id13', ...header.kdf_params, salt: header.salt });
  const { state, header: ssHeader } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const body = enc.encode(JSON.stringify(payload));
  const parts: Uint8Array[] = [enc.encode(BACKUP_MAGIC), headerBytes, enc.encode('\n'), ssHeader];
  for (let off = 0; off === 0 || off < body.length; off += CHUNK) {
    const last = off + CHUNK >= body.length;
    const ct = sodium.crypto_secretstream_xchacha20poly1305_push(
      state,
      body.subarray(off, off + CHUNK),
      off === 0 ? headerBytes : null, // binds the plaintext header to the ciphertext
      last
        ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, ct.length);
    parts.push(len, ct);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

/** Reads the unencrypted header (to show date/version before asking for the passphrase). */
export function readBackupHeader(file: Uint8Array): {
  header: BackupHeader;
  headerBytes: Uint8Array;
  offset: number;
} {
  const magic = enc.encode(BACKUP_MAGIC);
  if (file.length < magic.length || dec.decode(file.subarray(0, magic.length)) !== BACKUP_MAGIC)
    throw new BackupError('not a finance-platform backup file');
  const nl = file.indexOf(10, magic.length);
  if (nl < 0) throw new BackupError('corrupt backup header');
  const headerBytes = file.subarray(magic.length, nl);
  const header = JSON.parse(dec.decode(headerBytes)) as BackupHeader;
  if (header.format_version > BACKUP_FORMAT_VERSION)
    throw new BackupError(`backup format ${header.format_version} is newer than this app supports`);
  return { header, headerBytes, offset: nl + 1 };
}

async function decrypt(file: Uint8Array, passphrase: string): Promise<Payload> {
  await ready();
  const { header, headerBytes, offset } = readBackupHeader(file);
  const key = deriveKek(passphrase, { alg: 'argon2id13', ...header.kdf_params, salt: header.salt });
  const hb = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  let state: ReturnType<typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull>;
  try {
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
      file.subarray(offset, offset + hb),
      key,
    );
  } catch {
    throw new BackupError('corrupt backup');
  }
  const chunks: Uint8Array[] = [];
  let pos = offset + hb;
  let first = true;
  let final = false;
  while (pos < file.length) {
    if (final) throw new BackupError('data after the final chunk');
    const len = new DataView(file.buffer, file.byteOffset + pos, 4).getUint32(0);
    const ct = file.subarray(pos + 4, pos + 4 + len);
    pos += 4 + len;
    let r: { message: Uint8Array; tag: number } | false;
    try {
      r = sodium.crypto_secretstream_xchacha20poly1305_pull(state, ct, first ? headerBytes : null);
    } catch {
      r = false;
    }
    if (!r) throw new BackupError('wrong passphrase or damaged backup');
    first = false;
    chunks.push(r.message);
    final = r.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  }
  if (!final) throw new BackupError('backup is truncated');
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let i = 0;
  for (const c of chunks) {
    body.set(c, i);
    i += c.length;
  }
  const p = JSON.parse(dec.decode(body)) as Payload;
  if (p.format !== 'finplat-backup') throw new BackupError('unexpected backup payload');
  return p;
}

export interface RestoreResult {
  profiles: string[];
  rows: number;
  blobs: number;
}

/**
 * Complete restore. Profiles that already exist locally are refused unless overwrite is set;
 * then their local rows are replaced. Restored profiles are local-only (sync is re-activated
 * explicitly, which uploads them again).
 */
export async function importBackup(
  store: LocalStore,
  file: Uint8Array,
  passphrase: string,
  opts: { overwrite?: boolean } = {},
): Promise<RestoreResult> {
  const p = await decrypt(file, passphrase);
  if (p.schemaVersion > store.schemaVersion)
    throw new BackupError(
      `backup schema ${p.schemaVersion} is newer than this app (${store.schemaVersion}); update the app first`,
    );
  const blobs = p.blobs.map((b) => ({
    id: b.id,
    profileId: b.profileId,
    blob: new Blob([fromBase64(b.data) as Uint8Array<ArrayBuffer>], { type: b.type }),
  }));
  let rows = 0;
  await store.run('readwrite', ['profiles', 'blobs', ...BACKUP_TABLES], async (tx) => {
    for (const prof of p.profiles) {
      if ((await tx.get('profiles', prof.id)) && !opts.overwrite)
        throw new BackupError(`profile "${prof.name}" already exists on this device`);
      for (const t of BACKUP_TABLES)
        for (const r of await tx.query<{ id: string }>(t, {
          profileId: prof.id,
          includeDeleted: true,
        }))
          await tx.delete(t, r.id);
      for (const b of await tx.query<{ id: string }>('blobs', { profileId: prof.id }))
        await tx.delete('blobs', b.id);
      await tx.put('profiles', prof);
    }
    for (const [t, list] of Object.entries(p.tables)) {
      if (!(BACKUP_TABLES as readonly string[]).includes(t)) continue; // unknown table from a newer minor format
      for (const r of list) {
        await tx.put(t, r);
        rows++;
      }
    }
    for (const b of blobs) await tx.put('blobs', b);
  });
  return { profiles: p.profiles.map((x) => x.id), rows, blobs: blobs.length };
}
