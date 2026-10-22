// In-memory implementation of the sync endpoints, following docs/architecture/sync-protocol.md,
// used as the "mocked server" of the sync tests. Not shipped (not exported from index.ts).
import type {
  OperationResult,
  PushRequest,
  SyncChange,
  SyncConflict,
  SyncOperation,
} from '@finplat/domain';

type Data = Record<string, unknown>;
interface Entity {
  data: Data | null; // null = tombstone
  version: number;
  history: Map<number, Data>; // version -> snapshot
}

const MONEY_FIELDS = new Set([
  'postings',
  'splits',
  'kind',
  'amount',
  'targetAmount',
  'conversion',
  'bookingDate',
]);

export class FakeSyncServer {
  changes: (SyncChange & { profileId: string })[] = [];
  entities = new Map<string, Entity>(); // `${profile}|${type}|${id}`
  ops = new Map<string, OperationResult>();
  conflicts: (SyncConflict & { profileId: string; operation: SyncOperation })[] = [];
  keys: Data[] = [];
  e2ee = new Set<string>();
  head = new Map<string, number>();
  failNext = 0; // network failures before handling
  loseResponses = 0; // apply, then drop the response (client sees a network error)
  pushCalls = 0;
  settings = new Map<string, Data>(); // profile id -> settings object
  rates: Data[] = []; // exchange rate snapshots (profileId null = provider)

  fetch = async (req: Request): Promise<Response> => {
    if (this.failNext > 0) {
      this.failNext--;
      throw new TypeError('network down');
    }
    const url = new URL(req.url);
    const pid = req.headers.get('X-Profile-ID') ?? '';
    const json = (b: unknown, status = 200) => Response.json(b, { status });
    const p = url.pathname;
    if (p === '/api/v1/meta')
      return json({
        name: 'finance-platform',
        apiVersion: '1.0.0',
        schemaVersion: 1,
        syncProtocolVersion: 1,
        publicUrl: '',
        registrationPolicy: 'open',
        mcpEnabled: false,
      });
    if (p === '/api/v1/sync/push') {
      this.pushCalls++;
      const body = (await req.json()) as PushRequest;
      const res = json(this.push(body));
      if (this.loseResponses > 0) {
        this.loseResponses--;
        throw new TypeError('connection reset');
      }
      return res;
    }
    if (p === '/api/v1/sync/pull') {
      const since = Number(url.searchParams.get('since'));
      const limit = Number(url.searchParams.get('limit') ?? 500);
      const all = this.changes.filter((c) => c.profileId === pid && c.serverVersion > since);
      const page = all.slice(0, limit);
      return json({
        changes: page.map(strip),
        nextSince: page.at(-1)?.serverVersion ?? since,
        hasMore: all.length > limit,
        serverVersion: this.head.get(pid) ?? 0,
      });
    }
    if (p === '/api/v1/sync/snapshot') {
      const latest = new Map<string, SyncChange & { profileId: string }>();
      for (const c of this.changes)
        if (c.profileId === pid) latest.set(`${c.entityType}|${c.entityId}`, c);
      const items = [...latest.values()]
        .filter((c) => c.op === 'upsert')
        .sort((a, b) => a.serverVersion - b.serverVersion);
      const after = Number(url.searchParams.get('cursor') ?? 0);
      const rest = items.filter((c) => c.serverVersion > after);
      const page = rest.slice(0, 2); // tiny pages to exercise paging
      const more = rest.length > 2;
      const h = this.head.get(pid) ?? 0;
      return json({
        changes: page.map(strip),
        nextSince: h,
        hasMore: more,
        serverVersion: h,
        ...(more ? { nextCursor: String(page.at(-1)?.serverVersion) } : {}),
      });
    }
    if (p === '/api/v1/sync/conflicts')
      return json({
        items: this.conflicts
          .filter((c) => c.profileId === pid && c.status === 'open')
          .map(({ profileId: _p, operation: _o, ...c }) => c),
      });
    const m = p.match(/^\/api\/v1\/sync\/conflicts\/([^/]+)\/resolve$/);
    if (m) {
      const c = this.conflicts.find((x) => x.id === m[1]);
      if (!c) return json({ error: { code: 'not_found', message: 'nope' } }, 404);
      const body = (await req.json()) as { choice: string; data?: Data };
      const key = `${pid}|${c.entityType}|${c.entityId}`;
      const e = this.entities.get(key) as Entity;
      if (body.choice !== 'server') {
        const data = body.choice === 'merged' ? (body.data as Data) : (c.operation.data as Data);
        this.write(pid, c.entityType, c.entityId, e, data, null);
      }
      c.status = 'resolved';
      const { profileId: _p, operation: _o, ...out } = c;
      return json(out);
    }
    if (p === '/api/v1/sync/keys') {
      if (req.method === 'POST') {
        const k = {
          ...((await req.json()) as Data),
          profileId: pid,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        this.keys.push(k);
        return json(k, 201);
      }
      return json({
        items: this.keys.filter((k) => k.profileId === pid).map(({ profileId: _p, ...k }) => k),
      });
    }
    const sm = p.match(/^\/api\/v1\/profiles\/([^/]+)\/settings$/);
    if (sm) {
      const cur = this.settings.get(sm[1] as string) ?? {};
      if (req.method === 'PATCH') {
        for (const [k, v] of Object.entries((await req.json()) as Data))
          if (v === null) delete cur[k];
          else cur[k] = v;
        this.settings.set(sm[1] as string, cur);
      }
      return json(cur);
    }
    if (p === '/api/v1/exchange-rates') {
      if (req.method === 'POST') {
        const b = (await req.json()) as Data;
        if (
          this.rates.some(
            (r) =>
              r.profileId === pid &&
              r.baseCurrency === b.baseCurrency &&
              r.quoteCurrency === b.quoteCurrency &&
              r.rateDate === b.rateDate,
          )
        )
          return json({ error: { code: 'conflict', message: 'exists' } }, 409);
        const r = {
          providerCode: 'manual',
          ...b,
          profileId: pid,
          source: 'manual',
          fetchedAt: new Date().toISOString(),
        };
        this.rates.push(r);
        return json(r, 201);
      }
      const since = url.searchParams.get('changedSince');
      const mine = url.searchParams.get('scope') === 'profile';
      return json({
        items: this.rates.filter(
          (r) =>
            (r.profileId === pid || (r.profileId === null && !mine)) &&
            (!since || (r.fetchedAt as string) > since),
        ),
        nextCursor: null,
      });
    }
    return json({ error: { code: 'route_not_found', message: p } }, 404);
  };

  private write(
    pid: string,
    type: string,
    id: string,
    e: Entity,
    data: Data | null,
    opId: string | null,
  ) {
    e.version++;
    e.data = data && { ...data, version: e.version };
    if (e.data) e.history.set(e.version, e.data);
    const sv = (this.head.get(pid) ?? 0) + 1;
    this.head.set(pid, sv);
    this.changes.push({
      profileId: pid,
      serverVersion: sv,
      entityType: type,
      entityId: id,
      op: data ? 'upsert' : 'delete',
      data: e.data,
      opId,
      deviceId: null,
      changedAt: new Date().toISOString(),
    });
    return sv;
  }

  push(body: PushRequest) {
    const pid = body.profileId;
    const results: OperationResult[] = [];
    for (const op of body.operations) {
      const prev = this.ops.get(op.opId);
      if (prev) {
        results.push(prev);
        continue;
      }
      const r = this.apply(pid, op);
      this.ops.set(op.opId, r);
      results.push(r);
    }
    return { results, serverVersion: this.head.get(pid) ?? 0 };
  }

  private apply(pid: string, op: SyncOperation): OperationResult {
    const key = `${pid}|${op.entityType}|${op.entityId}`;
    const e = this.entities.get(key);
    const reject = (code: string, message: string): OperationResult => ({
      opId: op.opId,
      status: 'rejected',
      code,
      message,
    });
    const ok = (sv: number, en: Entity): OperationResult => ({
      opId: op.opId,
      status: 'applied',
      serverVersion: sv,
      version: en.version,
    });
    const enc = this.e2ee.has(pid);
    if (op.data && enc && !('ct' in op.data))
      return reject('invalid_envelope', 'e2ee profile needs envelopes');
    if (op.data && !enc) {
      if (op.data.profileId !== pid) return reject('validation_failed', 'profileId mismatch');
      const t = op.data as {
        postings?: { amount: { amount: string } }[];
        splits?: { amount: { amount: string } }[];
        kind?: string;
      };
      if (op.entityType === 'transactions' && t.splits?.length) {
        const cents = (s: string) => BigInt(s.replace('.', ''));
        const total = cents((t.postings?.[0]?.amount.amount ?? '0').replace('-', ''));
        const sum = t.splits.reduce((a, s) => a + cents(s.amount.amount), 0n);
        if (total !== sum) return reject('validation_failed', 'splits must sum to the amount');
      }
    }
    const strip = (d: Data | null) => {
      if (!d) return null;
      const { version: _v, serverVersion: _s, ...rest } = d;
      return rest;
    };
    if (op.op === 'delete') {
      if (!e) return reject('not_found', 'entity not found');
      if (!e.data)
        return {
          opId: op.opId,
          status: 'applied',
          serverVersion: this.head.get(pid) ?? 0,
          version: e.version,
        };
      if (op.baseVersion !== null && op.baseVersion !== e.version)
        return this.conflict(pid, op, ['*'], e);
      return ok(this.write(pid, op.entityType, op.entityId, e, null, op.opId), e);
    }
    if (op.baseVersion === null) {
      if (e)
        return JSON.stringify(strip(e.data)) === JSON.stringify(strip(op.data))
          ? ok(this.head.get(pid) ?? 0, e)
          : reject('id_conflict', 'exists');
      const n: Entity = { data: null, version: 0, history: new Map() };
      this.entities.set(key, n);
      return ok(this.write(pid, op.entityType, op.entityId, n, strip(op.data), op.opId), n);
    }
    if (!e?.data) return reject('not_found', 'entity not found');
    if (op.baseVersion === e.version)
      return ok(this.write(pid, op.entityType, op.entityId, e, strip(op.data), op.opId), e);
    if (enc) return this.conflict(pid, op, ['*'], e);
    // stale base: field-level merge of disjoint metadata, money fields never merge
    const base = e.history.get(op.baseVersion) ?? {};
    const serverChanged = Object.keys(e.data).filter(
      (k) => k !== 'version' && JSON.stringify(e.data?.[k]) !== JSON.stringify(base[k]),
    );
    const clientChanged = op.changedFields ?? Object.keys(op.data ?? {});
    const overlap = clientChanged.filter((f) => serverChanged.includes(f) || MONEY_FIELDS.has(f));
    if (overlap.length) return this.conflict(pid, op, overlap, e);
    const merged = { ...strip(e.data) } as Data;
    for (const f of clientChanged) merged[f] = (op.data as Data)[f];
    return ok(this.write(pid, op.entityType, op.entityId, e, merged, op.opId), e);
  }

  private conflict(pid: string, op: SyncOperation, fields: string[], e: Entity): OperationResult {
    const id = crypto.randomUUID();
    this.conflicts.push({
      id,
      profileId: pid,
      operation: op,
      op: op.op,
      entityType: op.entityType,
      entityId: op.entityId,
      opId: op.opId,
      baseVersion: op.baseVersion ?? 0,
      fields,
      serverData: e.data ?? {},
      clientData: op.data ?? {},
      status: 'open',
      createdAt: new Date().toISOString(),
    });
    return { opId: op.opId, status: 'conflict', conflictId: id, fields };
  }

  /** Server-side state of an entity (for assertions). */
  get(pid: string, type: string, id: string) {
    return this.entities.get(`${pid}|${type}|${id}`)?.data ?? null;
  }
}

function strip(c: SyncChange & { profileId: string }): SyncChange {
  const { profileId: _p, ...rest } = c;
  return rest;
}
