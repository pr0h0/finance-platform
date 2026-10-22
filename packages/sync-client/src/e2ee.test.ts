import { expect, test } from 'bun:test';
import { createApiClient } from '@finplat/api-client';
import { LocalDataSource, MemoryStore } from '@finplat/storage';
import sodium from 'libsodium-wrappers-sumo';
import { exportBackup, importBackup, readBackupHeader } from './backup.ts';
import {
  decodeRecovery,
  encodeRecovery,
  hashLockSecret,
  Keyring,
  KeyUnlockError,
  ready,
  verifyLockSecret,
} from './crypto.ts';
import { deviceKeyPair, enableE2ee, enrollDevice, rotateKey, unlock } from './e2ee.ts';
import { ProfileLockedError, SyncEngine } from './engine.ts';
import { FakeSyncServer } from './fake-server.test-util.ts';
import { RemoteDataSource } from './remote.ts';

await ready();
// Minimal Argon2id cost keeps tests fast; production uses defaultKdf() (MODERATE).
const KDF = {
  alg: 'argon2id13' as const,
  opslimit: sodium.crypto_pwhash_OPSLIMIT_MIN,
  memlimit: sodium.crypto_pwhash_MEMLIMIT_MIN,
};
const PID = '0190a000-0000-7000-8000-0000000000e2';
const m = (amount: string, currency = 'EUR') => ({ amount, currency });

async function device(server: FakeSyncServer, deviceId: string, keyring?: Keyring) {
  const store = new MemoryStore();
  await store.open();
  const api = createApiClient({ baseUrl: 'https://fin.test', fetch: server.fetch as typeof fetch });
  const ds = new RemoteDataSource({ store, api, deviceId, syncDelayMs: 60_000 });
  const engine = (k = keyring) =>
    new SyncEngine({
      store,
      api,
      localProfileId: PID,
      remoteProfileId: PID,
      deviceId,
      keyring: k,
      sleep: async () => undefined,
    });
  return { store, api, svc: ds.profile(PID), engine };
}

test('recovery code round-trips and tolerates typing noise', () => {
  const bytes = sodium.randombytes_buf(32);
  const code = encodeRecovery(bytes);
  expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){12}[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(decodeRecovery(code.toLowerCase().replace(/-/g, ' '))).toEqual(bytes);
  expect(() => decodeRecovery('AAAA')).toThrow();
});

test('E2EE: encrypt on device A, decrypt on device B; server only sees envelopes (§46 case 23)', async () => {
  const server = new FakeSyncServer();
  server.e2ee.add(PID);
  const a = await device(server, 'dev-a');
  const kpA = await deviceKeyPair(a.store);
  expect(await deviceKeyPair(a.store)).toEqual(kpA); // persisted

  const { keyring, recoveryCode } = await enableE2ee(a.api.sync, PID, {
    passphrase: 'correct horse battery',
    deviceId: 'dev-a',
    device: kpA,
    kdf: KDF,
  });
  const acc = await a.svc.create('accounts', {
    name: 'Secret savings',
    accountType: 'savings',
    currency: 'EUR',
    openingBalance: m('1234.56'),
  });
  await a.engine(keyring).sync();

  // nothing readable on the server
  const blob = JSON.stringify(server.changes);
  expect(blob).not.toContain('Secret savings');
  expect(blob).not.toContain('1234.56');
  expect(server.changes.every((c) => !c.data || ('ct' in c.data && 'nonce' in c.data))).toBe(true);

  // device B: wrong passphrase fails, right one decrypts
  const b = await device(server, 'dev-b');
  await expect(unlock(b.api.sync, PID, { passphrase: 'wrong passphrase!' })).rejects.toBeInstanceOf(
    KeyUnlockError,
  );
  const ringB = await unlock(b.api.sync, PID, { passphrase: 'correct horse battery' });
  await b.engine(ringB).sync();
  expect((await b.svc.get('accounts', acc.id)).balances).toEqual([m('1234.56')]);

  // B edits, A decrypts
  await b.svc.update('accounts', acc.id, { name: 'Renamed' });
  await b.engine(ringB).sync();
  await a.engine(keyring).sync();
  expect((await a.svc.get('accounts', acc.id)).name).toBe('Renamed');

  // a device that syncs before unlocking stores nothing (no ciphertext saved as records)
  const early = await device(server, 'dev-early');
  await expect(early.engine().sync()).rejects.toBeInstanceOf(ProfileLockedError);
  expect(await early.store.run('readonly', ['accounts'], (tx) => tx.query('accounts', {}))).toEqual(
    [],
  );
  const ringE = await unlock(early.api.sync, PID, { passphrase: 'correct horse battery' });
  await early.engine(ringE).sync();
  expect((await early.svc.get('accounts', acc.id)).name).toBe('Renamed');

  // device C: recovery code
  const c = await device(server, 'dev-c');
  const ringC = await unlock(c.api.sync, PID, { recoveryCode });
  await c.engine(ringC).sync();
  expect((await c.svc.get('accounts', acc.id)).name).toBe('Renamed');

  // device D: enrolled by B (sealed to D's device key), unlocks without any secret
  const d = await device(server, 'dev-d');
  const kpD = await deviceKeyPair(d.store);
  await enrollDevice(b.api.sync, PID, ringB, { deviceId: 'dev-d', publicKey: kpD.publicKey });
  const ringD = await unlock(d.api.sync, PID, { deviceId: 'dev-d', device: kpD });
  await d.engine(ringD).sync();
  expect((await d.svc.get('accounts', acc.id)).balances).toEqual([m('1234.56')]);
  // a different device's key cannot open D's envelope
  await expect(unlock(d.api.sync, PID, { deviceId: 'dev-d', device: kpA })).rejects.toBeInstanceOf(
    KeyUnlockError,
  );
});

test('E2EE: ciphertext is bound to its row (AAD) and key rotation keeps old data readable', async () => {
  const server = new FakeSyncServer();
  const ring = new Keyring();
  const a = await device(server, 'dev-a');
  const { keyring } = await enableE2ee(a.api.sync, PID, {
    passphrase: 'long passphrase 1',
    deviceId: 'dev-a',
    device: await deviceKeyPair(a.store),
    kdf: KDF,
  });
  const ctx = { profileId: PID, entityType: 'accounts', entityId: 'id-1' };
  const env = keyring.encrypt(ctx, { name: 'x' });
  expect(keyring.decrypt(ctx, env)).toEqual({ name: 'x' });
  expect(() => keyring.decrypt({ ...ctx, entityId: 'id-2' }, env)).toThrow('failed authentication');
  expect(() =>
    keyring.decrypt(ctx, { ...env, ct: env.ct.replace(/^./, env.ct[0] === 'A' ? 'B' : 'A') }),
  ).toThrow();
  expect(() => ring.encrypt(ctx, {})).toThrow('locked');

  const rotated = await rotateKey(a.api.sync, PID, keyring, {
    passphrase: 'new long passphrase',
    devices: [],
    kdf: KDF,
  });
  const env2 = rotated.keyring.encrypt(ctx, { name: 'y' });
  expect(env2.keyId).not.toBe(env.keyId);
  // a device unlocking with the new secrets gets every generation, newest current
  const again = await unlock(a.api.sync, PID, { passphrase: 'new long passphrase' });
  expect(again.current).toBe(env2.keyId);
  expect(again.decrypt(ctx, env)).toEqual({ name: 'x' });
  const viaCode = await unlock(a.api.sync, PID, { recoveryCode: rotated.recoveryCode });
  expect(viaCode.decrypt(ctx, env2)).toEqual({ name: 'y' });
});

test('encrypted backup: export on one device, restore on another', async () => {
  const s1 = new MemoryStore();
  await s1.open();
  const ds = new LocalDataSource(s1);
  const p = await ds.createProfile({ name: 'Home', baseCurrency: 'BAM' });
  const svc = ds.profile(p.id);
  const acc = await svc.create('accounts', {
    name: 'Cash',
    accountType: 'cash',
    currency: 'BAM',
    openingBalance: m('99.99', 'BAM'),
  });
  await svc.addAttachment({
    file: new Blob(['receipt-bytes'], { type: 'image/png' }),
    fileName: 'r.png',
  });
  await svc.setDashboardLayout(['balance']);

  const file = await exportBackup(s1, 'backup passphrase', { kdf: KDF });
  expect(readBackupHeader(file).header).toMatchObject({
    format_version: 1,
    kdf: 'argon2id13',
    alg: 'xchacha20poly1305-secretstream',
  });
  expect(new TextDecoder().decode(file)).not.toContain('Cash');

  const s2 = new MemoryStore();
  await s2.open();
  await expect(importBackup(s2, file, 'wrong')).rejects.toThrow('wrong passphrase');
  const tampered = file.slice();
  tampered[tampered.length - 5] = (tampered[tampered.length - 5] as number) ^ 1;
  await expect(importBackup(s2, tampered, 'backup passphrase')).rejects.toThrow();
  await expect(
    importBackup(s2, file.slice(0, file.length - 10), 'backup passphrase'),
  ).rejects.toThrow();

  const r = await importBackup(s2, file, 'backup passphrase');
  expect(r.profiles).toEqual([p.id]);
  const svc2 = new LocalDataSource(s2).profile(p.id);
  expect((await svc2.get('accounts', acc.id)).balances).toEqual([m('99.99', 'BAM')]);
  const [att] = await svc2.listAttachments();
  expect(await (await svc2.attachmentContent(att?.id as string)).text()).toBe('receipt-bytes');
  expect(await svc2.getDashboardLayout()).toEqual(['balance']);
  await expect(importBackup(s2, file, 'backup passphrase')).rejects.toThrow('already exists');
  await importBackup(s2, file, 'backup passphrase', { overwrite: true });
});

test('app lock verifier', async () => {
  const h = await hashLockSecret('1234');
  expect(h.startsWith('$argon2id$')).toBe(true);
  expect(await verifyLockSecret(h, '1234')).toBe(true);
  expect(await verifyLockSecret(h, '1235')).toBe(false);
  await expect(hashLockSecret('12')).rejects.toThrow();
});
