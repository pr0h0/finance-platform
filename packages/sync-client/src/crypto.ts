// End-to-end encryption primitives and key lifecycle (ADR 0005). libsodium only; no custom
// cryptography. The server stores envelopes and wrapped keys, never plaintext or keys.
import sodium from 'libsodium-wrappers-sumo';

export const ENVELOPE_ALG = 'xchacha20poly1305-ietf';
export const RECORD_SCHEMA_VERSION = 1;

/** Record ciphertext as stored by the server (sync_changes.data / encrypted_records.envelope). */
export interface Envelope {
  v: 1;
  alg: typeof ENVELOPE_ALG;
  keyId: string;
  nonce: string; // base64 (standard alphabet, padded)
  ct: string;
}

/** Argon2id parameters, stored with every password envelope so they can be raised later. */
export interface KdfParams {
  alg: 'argon2id13';
  opslimit: number;
  memlimit: number;
  salt: string; // base64
}

/** Wire shape of /api/v1/sync/keys (OpenAPI KeyEnvelope). */
export interface KeyEnvelope {
  id?: string;
  keyId: string;
  kind: 'password' | 'recovery' | 'device' | 'member';
  deviceId: string | null;
  wrappedKey: string; // base64
  kdfParams?: Record<string, unknown>;
  createdAt?: string;
}

export interface DeviceKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export async function ready(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
const unb64 = (s: string) => sodium.from_base64(s, sodium.base64_variants.ORIGINAL);

export { b64 as toBase64, unb64 as fromBase64 };

/** Web default (ADR 0005): OPSLIMIT/MEMLIMIT_MODERATE (256 MiB). Tests pass lighter params. */
export function defaultKdf(
  level: 'moderate' | 'interactive' = 'moderate',
): Omit<KdfParams, 'salt'> {
  return level === 'moderate'
    ? {
        alg: 'argon2id13',
        opslimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
        memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
      }
    : {
        alg: 'argon2id13',
        opslimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
        memlimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      };
}

export function newSalt(): string {
  return b64(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES));
}

export function deriveKek(passphrase: string, p: KdfParams): Uint8Array {
  if (p.alg !== 'argon2id13') throw new Error(`unsupported kdf ${p.alg}`);
  return sodium.crypto_pwhash(
    32,
    passphrase.normalize('NFKC'),
    unb64(p.salt),
    p.opslimit,
    p.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

// ------------------------------------------------------------ recovery codes

// Crockford base32 (no I, L, O, U): unambiguous when typed back from paper.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 256-bit random recovery code, shown once: 52 base32 chars in groups of 4. */
export function newRecoveryCode(): string {
  return encodeRecovery(sodium.randombytes_buf(32));
}

export function encodeRecovery(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return (out.match(/.{1,4}/g) ?? []).join('-');
}

export function decodeRecovery(code: string): Uint8Array {
  const clean = code.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (clean.length !== 52) throw new Error('recovery code must have 52 characters');
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error(`invalid recovery code character ${ch}`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 255);
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(out.slice(0, 32));
}

/** The recovery code already has 256 bits of entropy: a keyed BLAKE2b derivation suffices. */
const recoveryKek = (code: string) =>
  sodium.crypto_generichash(
    32,
    decodeRecovery(code),
    sodium.from_string('finplat-recovery-kek-v1'),
  );

// ------------------------------------------------------------ key wrapping

function wrap(key: Uint8Array, kek: Uint8Array, keyId: string): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    key,
    `finplat:pdk:${keyId}`,
    null,
    nonce,
    kek,
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return b64(out);
}

function unwrap(wrapped: string, kek: Uint8Array, keyId: string): Uint8Array {
  const raw = unb64(wrapped);
  const n = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      raw.slice(n),
      `finplat:pdk:${keyId}`,
      raw.slice(0, n),
      kek,
    );
  } catch {
    throw new KeyUnlockError('wrong passphrase or recovery code');
  }
}

export class KeyUnlockError extends Error {
  override name = 'KeyUnlockError';
}

export function newDeviceKeyPair(): DeviceKeyPair {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export interface ProfileKey {
  keyId: string;
  key: Uint8Array; // 256-bit Profile Data Key
}

export function newProfileKey(): ProfileKey {
  return {
    keyId: `k${Date.now().toString(36)}${b64(sodium.randombytes_buf(6)).replace(/[+/=]/g, '')}`,
    key: sodium.crypto_aead_xchacha20poly1305_ietf_keygen(),
  };
}

export function passwordEnvelope(
  pk: ProfileKey,
  passphrase: string,
  kdf: Omit<KdfParams, 'salt'>,
): KeyEnvelope {
  const params: KdfParams = { ...kdf, salt: newSalt() };
  return {
    keyId: pk.keyId,
    kind: 'password',
    deviceId: null,
    wrappedKey: wrap(pk.key, deriveKek(passphrase, params), pk.keyId),
    kdfParams: { ...params },
  };
}

export function recoveryEnvelope(pk: ProfileKey, code: string): KeyEnvelope {
  return {
    keyId: pk.keyId,
    kind: 'recovery',
    deviceId: null,
    wrappedKey: wrap(pk.key, recoveryKek(code), pk.keyId),
    kdfParams: { alg: 'blake2b-recovery-v1' },
  };
}

/** Sealed to a device's X25519 public key (enrollment). Also used for household members. */
export function sealedEnvelope(
  pk: ProfileKey,
  publicKey: Uint8Array,
  deviceId: string,
  kind: 'device' | 'member' = 'device',
): KeyEnvelope {
  const msg = new TextEncoder().encode(JSON.stringify({ keyId: pk.keyId, key: b64(pk.key) }));
  return {
    keyId: pk.keyId,
    kind,
    deviceId,
    wrappedKey: b64(sodium.crypto_box_seal(msg, publicKey)),
  };
}

export function openPassword(env: KeyEnvelope, passphrase: string): ProfileKey {
  const p = env.kdfParams as unknown as KdfParams;
  return { keyId: env.keyId, key: unwrap(env.wrappedKey, deriveKek(passphrase, p), env.keyId) };
}

export function openRecovery(env: KeyEnvelope, code: string): ProfileKey {
  return { keyId: env.keyId, key: unwrap(env.wrappedKey, recoveryKek(code), env.keyId) };
}

export function openSealed(env: KeyEnvelope, kp: DeviceKeyPair): ProfileKey {
  let msg: Uint8Array;
  try {
    msg = sodium.crypto_box_seal_open(unb64(env.wrappedKey), kp.publicKey, kp.privateKey);
  } catch {
    throw new KeyUnlockError('envelope is not sealed to this device');
  }
  const o = JSON.parse(new TextDecoder().decode(msg)) as { keyId: string; key: string };
  if (o.keyId !== env.keyId) throw new KeyUnlockError('key id mismatch');
  return { keyId: o.keyId, key: unb64(o.key) };
}

// ------------------------------------------------------------ records

export interface RecordContext {
  profileId: string; // server profile id
  entityType: string;
  entityId: string;
}

/** AAD binds a ciphertext to its row, so envelopes cannot be swapped between rows/profiles. */
const aad = (c: RecordContext, keyId: string) =>
  `${c.profileId}|${c.entityType}|${c.entityId}|${keyId}|${RECORD_SCHEMA_VERSION}`;

/** Holds every known key generation; new writes use `current`, old keys still decrypt. */
export class Keyring {
  private keys = new Map<string, Uint8Array>();
  current: string | null = null;

  add(pk: ProfileKey, makeCurrent = true): void {
    this.keys.set(pk.keyId, pk.key);
    if (makeCurrent || !this.current) this.current = pk.keyId;
  }

  has(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  ids(): string[] {
    return [...this.keys.keys()];
  }

  export(): { current: string | null; keys: Record<string, string> } {
    return {
      current: this.current,
      keys: Object.fromEntries([...this.keys].map(([k, v]) => [k, b64(v)])),
    };
  }

  static import(o: { current: string | null; keys: Record<string, string> }): Keyring {
    const r = new Keyring();
    for (const [k, v] of Object.entries(o.keys)) r.keys.set(k, unb64(v));
    r.current = o.current;
    return r;
  }

  encrypt(c: RecordContext, data: unknown): Envelope {
    if (!this.current) throw new Error('keyring is locked');
    const key = this.keys.get(this.current) as Uint8Array;
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      JSON.stringify(data),
      aad(c, this.current),
      null,
      nonce,
      key,
    );
    return { v: 1, alg: ENVELOPE_ALG, keyId: this.current, nonce: b64(nonce), ct: b64(ct) };
  }

  decrypt<T = Record<string, unknown>>(c: RecordContext, e: Envelope): T {
    if (e.v !== 1 || e.alg !== ENVELOPE_ALG)
      throw new Error(`unsupported envelope ${e.v}/${e.alg}`);
    const key = this.keys.get(e.keyId);
    if (!key)
      throw new KeyUnlockError(`missing key ${e.keyId}; unlock with passphrase or recovery code`);
    let pt: Uint8Array;
    try {
      pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        unb64(e.ct),
        aad(c, e.keyId),
        unb64(e.nonce),
        key,
      );
    } catch {
      throw new Error(`envelope for ${c.entityType}/${c.entityId} failed authentication`);
    }
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  }
}

export function isEnvelope(d: unknown): d is Envelope {
  const e = d as Partial<Envelope> | null;
  return (
    !!e &&
    e.v === 1 &&
    e.alg === ENVELOPE_ALG &&
    typeof e.ct === 'string' &&
    typeof e.nonce === 'string'
  );
}

// ------------------------------------------------------------ application lock (feature 91)

/** Argon2id verifier for the app lock PIN/passphrase (stored locally, e.g. setMeta('lock')).
 * The lock gates the UI; it does not encrypt the local database (browser limitation, see docs). */
export async function hashLockSecret(
  secret: string,
  level: 'moderate' | 'interactive' = 'interactive',
) {
  await ready();
  if (secret.length < 4) throw new Error('PIN must have at least 4 characters');
  const k = defaultKdf(level);
  return sodium.crypto_pwhash_str(secret.normalize('NFKC'), k.opslimit, k.memlimit);
}

export async function verifyLockSecret(hash: string, secret: string): Promise<boolean> {
  await ready();
  try {
    return sodium.crypto_pwhash_str_verify(hash, secret.normalize('NFKC'));
  } catch {
    return false;
  }
}
