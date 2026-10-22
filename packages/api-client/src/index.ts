// Typed REST client for docs/api/openapi.yaml. Types are generated (src/schema.gen.ts, run
// `scripts/bun.sh run --filter @finplat/api-client generate` after changing the spec); the client
// is openapi-fetch plus: same-origin/remote base URL, session cookie + X-CSRF-Token, X-Profile-ID,
// Idempotency-Key on unsafe methods, and error mapping to ApiError.
import type {
  ApiErrorBody,
  PullResponse,
  PushRequest,
  PushResponse,
  ServerMeta,
  SyncConflict,
} from '@finplat/domain';
import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema.gen.ts';

export type { components, paths };
export type Schemas = components['schemas'];
/** OpenAPI KeyEnvelope with kdfParams as a free-form object. */
export type KeyEnvelopeWire = Omit<Schemas['KeyEnvelope'], 'kdfParams'> & {
  kdfParams?: Record<string, unknown>;
};

/** Major version of the REST API this client speaks (docs/api/openapi.yaml). */
export const CLIENT_API_MAJOR = 1;
export const CLIENT_SYNC_PROTOCOL = 1;

export class ApiError extends Error {
  constructor(
    readonly status: number, // 0 = network failure (offline, DNS, CORS, aborted)
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }

  /** Worth retrying later with the same Idempotency-Key / opIds. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface ClientOptions {
  baseUrl: string; // '' for same-origin
  profileId?: () => string | undefined;
  fetch?: typeof fetch;
  /** Bearer token for non-browser clients; browsers use the HttpOnly session cookie. */
  token?: () => string | undefined;
  /** Called on 401 so the app can show the login screen (data stays local). */
  onUnauthenticated?: () => void;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function toApiError(res: Response): Promise<ApiError> {
  const json = (await res
    .clone()
    .json()
    .catch(() => null)) as ApiErrorBody | null;
  const e = json?.error;
  return new ApiError(
    res.status,
    e?.code ?? 'http_error',
    e?.message ?? (res.statusText || `HTTP ${res.status}`),
    e?.details,
    e?.requestId ?? res.headers.get('X-Request-ID') ?? undefined,
  );
}

export function createApiClient(opts: ClientOptions) {
  const baseFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let csrf: string | undefined;
  // '' = same origin; Request() needs an absolute URL outside documents (tests, workers).
  const baseUrl =
    opts.baseUrl ||
    ((globalThis as { location?: { origin?: string } }).location?.origin ?? 'http://localhost');

  const doFetch = async (input: Request): Promise<Response> => {
    try {
      return await baseFetch(input);
    } catch (e) {
      throw new ApiError(0, 'network_error', e instanceof Error ? e.message : String(e));
    }
  };

  const mw: Middleware = {
    onRequest({ request }) {
      const h = request.headers;
      h.set('Accept', 'application/json');
      const pid = opts.profileId?.();
      if (pid && !h.has('X-Profile-ID')) h.set('X-Profile-ID', pid);
      const tok = opts.token?.();
      if (tok) h.set('Authorization', `Bearer ${tok}`);
      if (UNSAFE.has(request.method)) {
        if (csrf && !tok) h.set('X-CSRF-Token', csrf);
        if (!h.has('Idempotency-Key')) h.set('Idempotency-Key', newIdempotencyKey());
      }
      return request;
    },
    async onResponse({ response }) {
      if (response.ok) {
        // login / register / GET /auth/session return the CSRF token for this session
        if (response.headers.get('content-type')?.includes('json')) {
          const body = (await response
            .clone()
            .json()
            .catch(() => null)) as { csrfToken?: string } | null;
          if (body && typeof body.csrfToken === 'string') csrf = body.csrfToken;
        }
        return response;
      }
      if (response.status === 401) opts.onUnauthenticated?.();
      throw await toApiError(response);
    },
  };

  const client = createClient<paths>({
    baseUrl,
    credentials: 'include',
    fetch: doFetch,
  });
  client.use(mw);

  /** Raw body (FormData, Blob) and raw Response (downloads); same headers/error mapping. */
  async function send(
    method: string,
    path: string,
    body?: RequestInit['body'],
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const req = new Request(`${baseUrl}${path}`, { method, headers, credentials: 'include', body });
    const r = (await mw.onRequest?.({ request: req } as never)) as Request;
    return (await mw.onResponse?.({ request: r, response: await doFetch(r) } as never)) as Response;
  }

  /** Untyped escape hatch (same headers/error mapping). */
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const res = await send(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    );
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const ph = (profileId: string) => ({ 'X-Profile-ID': profileId });

  return {
    /** Fully typed openapi-fetch client: client.GET('/api/v1/accounts', {params: {header: ...}}) */
    client,
    request,
    send,
    setCsrfToken: (t: string | undefined) => {
      csrf = t;
    },
    getMeta: () => request<ServerMeta>('GET', '/api/v1/meta'),
    session: () => request<Schemas['LoginResponse']>('GET', '/api/v1/auth/session'),
    login: (body: Schemas['LoginRequest']) =>
      request<Schemas['LoginResponse']>('POST', '/api/v1/auth/login', body),
    logout: () => request<void>('POST', '/api/v1/auth/logout'),
    listProfiles: () =>
      request<{ items: Schemas['Profile'][] }>('GET', '/api/v1/profiles').then((r) => r.items),
    createProfile: (body: Schemas['ProfileInput']) =>
      request<Schemas['Profile']>('POST', '/api/v1/profiles', body),
    sync: {
      push: (body: PushRequest) =>
        request<PushResponse>('POST', '/api/v1/sync/push', body, ph(body.profileId)),
      pull: (profileId: string, since: number, limit: number, deviceId?: string) =>
        request<PullResponse>(
          'GET',
          `/api/v1/sync/pull?since=${since}&limit=${limit}${deviceId ? `&deviceId=${deviceId}` : ''}`,
          undefined,
          ph(profileId),
        ),
      snapshot: (profileId: string, cursor?: string) =>
        request<PullResponse & { nextCursor?: string }>(
          'GET',
          `/api/v1/sync/snapshot${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
          undefined,
          ph(profileId),
        ),
      status: (profileId: string) =>
        request<Schemas['SyncStatus']>('GET', '/api/v1/sync/status', undefined, ph(profileId)),
      conflicts: (profileId: string) =>
        request<{ items: SyncConflict[] }>(
          'GET',
          '/api/v1/sync/conflicts',
          undefined,
          ph(profileId),
        ).then((r) => r.items),
      resolve: (
        profileId: string,
        id: string,
        body: { choice: 'server' | 'client' | 'merged'; data?: Record<string, unknown> },
      ) =>
        request<SyncConflict>('POST', `/api/v1/sync/conflicts/${id}/resolve`, body, ph(profileId)),
      keys: (profileId: string) =>
        request<{ items: KeyEnvelopeWire[] }>(
          'GET',
          '/api/v1/sync/keys',
          undefined,
          ph(profileId),
        ).then((r) => r.items),
      putKey: (profileId: string, body: KeyEnvelopeWire) =>
        request<KeyEnvelopeWire>('POST', '/api/v1/sync/keys', body, ph(profileId)),
    },
    devices: () =>
      request<{ items: Schemas['Device'][] }>('GET', '/api/v1/devices').then((r) => r.items),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Feature 107: refuse servers that are not this platform or speak an incompatible version. */
export function checkCompatibility(meta: ServerMeta): { ok: true } | { ok: false; reason: string } {
  if (meta.name !== 'finance-platform')
    return { ok: false, reason: 'not a finance-platform server' };
  const major = Number(meta.apiVersion.split('.')[0]);
  if (major !== CLIENT_API_MAJOR)
    return {
      ok: false,
      reason: `server API v${meta.apiVersion}, client needs v${CLIENT_API_MAJOR}.x`,
    };
  if (meta.syncProtocolVersion !== CLIENT_SYNC_PROTOCOL)
    return { ok: false, reason: `sync protocol ${meta.syncProtocolVersion} unsupported` };
  return { ok: true };
}

/**
 * Feature 107: normalize a user-entered server URL. Only https (or http on localhost for
 * development) is accepted so financial data is never sent in clear text by accident.
 */
export function normalizeServerUrl(
  input: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
    return { ok: false, reason: 'the server must use https' };
  if (u.username || u.password)
    return { ok: false, reason: 'credentials in the URL are not allowed' };
  if (u.search || u.hash)
    return { ok: false, reason: 'the URL must not contain a query or fragment' };
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}
