// The data API the web app uses, identical in both modes (PLAN §20):
// - LocalDataSource: local-only mode, IndexedDB, no server.
// - RemoteDataSource (@finplat/sync-client): connected mode. Same LocalFinanceService on a
//   per-server cache store; every write is queued in the outbox and pushed by the sync engine,
//   remote changes are pulled into the cache. UI code never branches on the mode.
import type { Profile } from '@finplat/domain';
import type { z } from '@finplat/validation';
import { uuidv7 } from './ids.ts';
import { parse } from './local/errors.ts';
import { profileInput } from './local/schemas.ts';
import { LocalFinanceService, type ServiceOptions } from './local/service.ts';
import type { LocalStore } from './types.ts';

/** Every operation of one profile (accounts, transactions, budgets, imports, ...). */
export type FinanceOps = Pick<
  LocalFinanceService,
  Exclude<keyof LocalFinanceService, 'store' | 'profileId'>
>;

export type ProfileInput = z.input<typeof profileInput>;

export interface DataSource {
  readonly mode: 'local' | 'remote';
  listProfiles(): Promise<Profile[]>;
  createProfile(input: ProfileInput): Promise<Profile>;
  profile(profileId: string): FinanceOps;
}

export const LOCAL_OWNER = 'local';

export class LocalDataSource implements DataSource {
  readonly mode = 'local' as const;
  private services = new Map<string, LocalFinanceService>();

  constructor(
    readonly store: LocalStore,
    private opts: ServiceOptions = {},
  ) {}

  async listProfiles(): Promise<Profile[]> {
    const rows = await this.store.run('readonly', ['profiles'], (tx) =>
      tx.query<Profile>('profiles', {}),
    );
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createProfile(input: ProfileInput): Promise<Profile> {
    const v = parse(profileInput, input);
    const t = (this.opts.now?.() ?? new Date()).toISOString();
    const p: Profile = {
      id: v.id ?? uuidv7(),
      name: v.name,
      ownerUserId: LOCAL_OWNER,
      householdId: null,
      baseCurrency: v.baseCurrency,
      timezone: v.timezone,
      locale: v.locale,
      weekStart: v.weekStart,
      privacyMode: 'server_readable',
      role: 'owner',
      syncVersion: 0,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
    };
    await this.store.run('readwrite', ['profiles'], (tx) => tx.put('profiles', p));
    return p;
  }

  profile(profileId: string): LocalFinanceService {
    let s = this.services.get(profileId);
    if (!s) {
      s = new LocalFinanceService(this.store, profileId, this.opts);
      this.services.set(profileId, s);
    }
    return s;
  }
}
