// E2EE key lifecycle on top of /api/v1/sync/keys (ADR 0005): enable, unlock (passphrase,
// recovery code or enrolled device), enroll a new device, rotate after a revocation.
import type { ApiClient } from '@finplat/api-client';
import { getMeta, type LocalStore, setMeta } from '@finplat/storage';
import {
  type DeviceKeyPair,
  defaultKdf,
  fromBase64,
  type KdfParams,
  type KeyEnvelope,
  Keyring,
  KeyUnlockError,
  newDeviceKeyPair,
  newProfileKey,
  newRecoveryCode,
  openPassword,
  openRecovery,
  openSealed,
  type ProfileKey,
  passwordEnvelope,
  ready,
  recoveryEnvelope,
  sealedEnvelope,
  toBase64,
} from './crypto.ts';

type KeyApi = Pick<ApiClient['sync'], 'keys' | 'putKey'>;

/** The device's X25519 key pair, kept in the local store (browser storage is not a secure
 * enclave: anyone with access to this browser profile can read it; see docs). */
export async function deviceKeyPair(store: LocalStore): Promise<DeviceKeyPair> {
  await ready();
  const saved = await getMeta<{ publicKey: string; privateKey: string }>(store, 'e2ee:device-key');
  if (saved)
    return { publicKey: fromBase64(saved.publicKey), privateKey: fromBase64(saved.privateKey) };
  const kp = newDeviceKeyPair();
  await setMeta(store, 'e2ee:device-key', {
    publicKey: toBase64(kp.publicKey),
    privateKey: toBase64(kp.privateKey),
  });
  return kp;
}

export async function saveKeyring(store: LocalStore, profileId: string, k: Keyring) {
  await setMeta(store, `e2ee:keyring:${profileId}`, k.export());
}

export async function loadKeyring(store: LocalStore, profileId: string): Promise<Keyring | null> {
  await ready();
  const o = await getMeta<ReturnType<Keyring['export']>>(store, `e2ee:keyring:${profileId}`);
  return o ? Keyring.import(o) : null;
}

/** First device: create the Profile Data Key, wrap it for passphrase, recovery code and this
 * device. Returns the recovery code; show it once and tell the user that losing both the
 * passphrase and the code makes the data unrecoverable. */
export async function enableE2ee(
  api: KeyApi,
  profileId: string,
  opts: {
    passphrase: string;
    deviceId: string;
    device: DeviceKeyPair;
    kdf?: Omit<KdfParams, 'salt'>;
  },
): Promise<{ keyring: Keyring; recoveryCode: string }> {
  await ready();
  if (opts.passphrase.length < 10) throw new Error('passphrase must have at least 10 characters');
  const pk = newProfileKey();
  const recoveryCode = newRecoveryCode();
  await uploadGeneration(
    api,
    profileId,
    pk,
    opts.passphrase,
    recoveryCode,
    [{ deviceId: opts.deviceId, publicKey: opts.device.publicKey }],
    opts.kdf,
  );
  const keyring = new Keyring();
  keyring.add(pk);
  return { keyring, recoveryCode };
}

async function uploadGeneration(
  api: KeyApi,
  profileId: string,
  pk: ProfileKey,
  passphrase: string,
  recoveryCode: string,
  devices: { deviceId: string; publicKey: Uint8Array }[],
  kdf = defaultKdf(),
) {
  await api.putKey(profileId, passwordEnvelope(pk, passphrase, kdf));
  await api.putKey(profileId, recoveryEnvelope(pk, recoveryCode));
  for (const d of devices) await api.putKey(profileId, sealedEnvelope(pk, d.publicKey, d.deviceId));
}

export type UnlockWith =
  | { passphrase: string }
  | { recoveryCode: string }
  | { deviceId: string; device: DeviceKeyPair };

/** Opens every key generation reachable with the given secret. The newest is current. */
export async function unlock(api: KeyApi, profileId: string, w: UnlockWith): Promise<Keyring> {
  await ready();
  const envs = (await api.keys(profileId)) as KeyEnvelope[];
  const ring = new Keyring();
  let lastErr: unknown = null;
  for (const e of envs) {
    if (ring.has(e.keyId)) continue;
    try {
      if ('passphrase' in w && e.kind === 'password') ring.add(openPassword(e, w.passphrase));
      else if ('recoveryCode' in w && e.kind === 'recovery')
        ring.add(openRecovery(e, w.recoveryCode));
      else if (
        'device' in w &&
        (e.kind === 'device' || e.kind === 'member') &&
        e.deviceId === w.deviceId
      )
        ring.add(openSealed(e, w.device));
    } catch (err) {
      lastErr = err;
    }
  }
  if (!ring.current) throw lastErr ?? new KeyUnlockError('no key envelope for this unlock method');
  ring.current = ring.ids().sort().at(-1) ?? null; // keyIds start with a base36 timestamp
  return ring;
}

/** An unlocked device seals every key generation to a new device's public key. */
export async function enrollDevice(
  api: KeyApi,
  profileId: string,
  keyring: Keyring,
  device: { deviceId: string; publicKey: Uint8Array },
): Promise<void> {
  const exported = keyring.export();
  for (const [keyId, key] of Object.entries(exported.keys))
    await api.putKey(
      profileId,
      sealedEnvelope({ keyId, key: fromBase64(key) }, device.publicKey, device.deviceId),
    );
}

/** After revoking a device or member: a new generation for the remaining devices only. New
 * writes use it; old records stay readable with old keys (re-encrypt lazily). A revoked party
 * keeps what it already downloaded — that cannot be recalled. */
export async function rotateKey(
  api: KeyApi,
  profileId: string,
  keyring: Keyring,
  opts: {
    passphrase: string;
    devices: { deviceId: string; publicKey: Uint8Array }[];
    kdf?: Omit<KdfParams, 'salt'>;
  },
): Promise<{ keyring: Keyring; recoveryCode: string }> {
  await ready();
  const pk = newProfileKey();
  const recoveryCode = newRecoveryCode();
  const next = Keyring.import(keyring.export());
  next.add(pk);
  // every generation (old ones too) becomes reachable with the new passphrase/recovery code
  for (const [keyId, key] of Object.entries(next.export().keys))
    await uploadGeneration(
      api,
      profileId,
      { keyId, key: fromBase64(key) },
      opts.passphrase,
      recoveryCode,
      keyId === pk.keyId ? opts.devices : [],
      opts.kdf,
    );
  return { keyring: next, recoveryCode };
}
