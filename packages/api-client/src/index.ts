import type { ApiErrorBody, ServerMeta } from '@finplat/domain';

/** Major version of the REST API this client speaks (docs/api/openapi.yaml). */
export const CLIENT_API_MAJOR = 1;
export const CLIENT_SYNC_PROTOCOL = 1;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  baseUrl: string; // '' for same-origin
  profileId?: () => string | undefined;
  fetch?: typeof fetch;
}

export function createApiClient(opts: ClientOptions) {
  const f = opts.fetch ?? fetch;
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const h: Record<string, string> = { Accept: 'application/json', ...headers };
    const pid = opts.profileId?.();
    if (pid) h['X-Profile-ID'] = pid;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await f(`${opts.baseUrl}${path}`, {
      method,
      headers: h,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const e = (json as ApiErrorBody | null)?.error;
      throw new ApiError(
        res.status,
        e?.code ?? 'http_error',
        e?.message ?? res.statusText,
        e?.details,
        e?.requestId,
      );
    }
    return json as T;
  }
  return { request, getMeta: () => request<ServerMeta>('GET', '/api/v1/meta') };
}

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
