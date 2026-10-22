import { checkCompatibility, createApiClient } from '@finplat/api-client';
import type { ServerMeta } from '@finplat/domain';
import { appFetch } from '../platform/native.ts';

export type ServerStatus =
  | { state: 'checking' }
  | { state: 'ok'; meta: ServerMeta }
  | { state: 'incompatible'; reason: string }
  | { state: 'unreachable'; reason: string };

export async function fetchServerStatus(
  baseUrl = '',
  f: typeof fetch = appFetch,
): Promise<ServerStatus> {
  try {
    const meta = await createApiClient({ baseUrl, fetch: f }).getMeta();
    const c = checkCompatibility(meta);
    return c.ok ? { state: 'ok', meta } : { state: 'incompatible', reason: c.reason };
  } catch (e) {
    return { state: 'unreachable', reason: e instanceof Error ? e.message : String(e) };
  }
}
