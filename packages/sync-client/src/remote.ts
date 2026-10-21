// Connected-mode DataSource: the same LocalFinanceService on a local cache store (offline edits,
// local analytics), with every write queued and pushed by a per-profile SyncEngine, and remote
// changes pulled into the cache. Profiles come from the server and are cached for offline use.
import type { ApiClient } from '@finplat/api-client';
import type { Profile } from '@finplat/domain';
import {
  type DataSource,
  LocalFinanceService,
  type LocalStore,
  type ProfileInput,
  type ServiceOptions,
} from '@finplat/storage';
import type { Keyring } from './crypto.ts';
import { SyncEngine } from './engine.ts';

export interface RemoteDataSourceOptions {
  store: LocalStore; // one cache database per server (e.g. IdbStore(`finplat@${host}`))
  api: ApiClient;
  deviceId: string;
  /** Unlocked keyring for e2ee profiles; undefined = server-readable profile. */
  keyringFor?: (profileId: string) => Keyring | undefined;
  service?: ServiceOptions;
  syncDelayMs?: number;
}

export class RemoteDataSource implements DataSource {
  readonly mode = 'remote' as const;
  private services = new Map<string, LocalFinanceService>();
  private engines = new Map<string, SyncEngine>();

  constructor(private o: RemoteDataSourceOptions) {}

  async listProfiles(): Promise<Profile[]> {
    try {
      const list = (await this.o.api.listProfiles()) as Profile[];
      await this.o.store.run('readwrite', ['profiles'], async (tx) => {
        for (const p of list) await tx.put('profiles', p);
      });
      return list;
    } catch (e) {
      if ((e as { status?: number }).status !== 0) throw e;
      // offline: last known profiles
      return this.o.store.run('readonly', ['profiles'], (tx) => tx.query<Profile>('profiles', {}));
    }
  }

  async createProfile(input: ProfileInput): Promise<Profile> {
    const p = (await this.o.api.createProfile(input as never)) as Profile;
    await this.o.store.run('readwrite', ['profiles'], (tx) => tx.put('profiles', p));
    return p;
  }

  engine(profileId: string): SyncEngine {
    let e = this.engines.get(profileId);
    if (!e) {
      e = new SyncEngine({
        store: this.o.store,
        api: this.o.api,
        localProfileId: profileId,
        remoteProfileId: profileId,
        deviceId: this.o.deviceId,
        keyring: this.o.keyringFor?.(profileId),
      });
      this.engines.set(profileId, e);
    }
    return e;
  }

  profile(profileId: string): LocalFinanceService {
    let s = this.services.get(profileId);
    if (!s) {
      const engine = this.engine(profileId);
      s = new LocalFinanceService(this.o.store, profileId, {
        ...this.o.service,
        onWrite: () => engine.schedule(this.o.syncDelayMs),
      });
      this.services.set(profileId, s);
    }
    return s;
  }
}
