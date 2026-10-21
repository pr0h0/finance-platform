// Sync against a REAL API. Skipped unless FINPLAT_API_URL is set, e.g.
//   sg docker -c "docker compose -f docker-compose.dev.yml up -d"        # api on 127.0.0.1:3811
//   FINPLAT_API_URL=http://127.0.0.1:3811 scripts/bun.sh test packages/sync-client/src/real-server.test.ts
// (scripts/bun.sh joins the dev network when it is up; use http://api:8080 from inside it.)
import { expect, test } from 'bun:test';
import { type ApiClient, createApiClient } from '@finplat/api-client';
import { MemoryStore } from '@finplat/storage';
import { SyncEngine } from './engine.ts';
import { RemoteDataSource } from './remote.ts';

const URL_ = process.env.FINPLAT_API_URL;

async function login(email: string, password: string, name: string) {
  let token: string | undefined;
  const api = createApiClient({ baseUrl: URL_ as string, token: () => token });
  const r = (await api.request('POST', '/api/v1/auth/login', {
    email,
    password,
    device: { name, platform: 'cli', clientVersion: 'sync-client-test' },
  })) as { token: string; deviceId: string };
  token = r.token;
  return { api, deviceId: r.deviceId };
}

async function device(api: ApiClient, deviceId: string, profileId: string) {
  const store = new MemoryStore();
  await store.open();
  const ds = new RemoteDataSource({ store, api, deviceId, syncDelayMs: 60_000 });
  const engine = new SyncEngine({
    store,
    api,
    localProfileId: profileId,
    remoteProfileId: profileId,
    deviceId,
  });
  return { svc: ds.profile(profileId), engine };
}

test.skipIf(!URL_)('real server: two devices converge, tombstones travel', async () => {
  const email = `sync-${Date.now()}@example.test`;
  const password = 'correct horse battery staple';
  const anon = createApiClient({ baseUrl: URL_ as string });
  await anon.request('POST', '/api/v1/auth/register', {
    email,
    password,
    displayName: 'Sync test',
  });
  const a = await login(email, password, 'device A');
  const b = await login(email, password, 'device B');
  const profile = (await a.api.createProfile({ name: 'Sync test', baseCurrency: 'BAM' })) as {
    id: string;
  };

  const da = await device(a.api, a.deviceId, profile.id);
  const db = await device(b.api, b.deviceId, profile.id);
  const tag = await da.svc.create('tags', { name: 'trip' });
  const acc = await da.svc.create('accounts', {
    name: 'Cash',
    accountType: 'cash',
    currency: 'BAM',
  });
  await da.svc.createTransaction({
    kind: 'expense',
    accountId: acc.id,
    amount: { amount: '12.30', currency: 'BAM' },
    bookingDate: '2026-04-01',
    tagIds: [tag.id],
  });
  const st = await da.engine.sync();
  expect(st.rejected.map((r) => `${r.entityType}: ${r.error?.code} ${r.error?.message}`)).toEqual(
    [],
  );
  expect(st.pending).toBe(0);

  await db.engine.sync();
  expect((await db.svc.get('accounts', acc.id)).balances).toEqual([
    { amount: '-12.30', currency: 'BAM' },
  ]);
  await db.svc.remove('tags', tag.id);
  await db.engine.sync();
  await da.engine.sync();
  expect(await da.svc.list('tags')).toEqual([]);
});
