// Passkeys (WebAuthn) against /api/v1/auth/passkeys/*: the browser ceremony is @simplewebauthn/browser;
// the server issues single-use options and verifies the result. Passkey sign-in returns the same
// LoginResponse (cookie session + csrfToken) as password sign-in.
import type { ApiClient, Schemas } from '@finplat/api-client';
import {
  type AuthenticationResponseJSON,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import { isNative } from '../platform/native.ts';

// WebAuthn is bound to the server's web origin: the native app (tauri:// origin) cannot use passkeys.
export const passkeysSupported = (): boolean => !isNative && browserSupportsWebAuthn();
export const passkeyAutofillSupported = (): Promise<boolean> =>
  browserSupportsWebAuthnAutofill().catch(() => false);
/** Abort a pending (autofill) ceremony, e.g. when the login form unmounts. */
export const cancelPasskeyCeremony = () => WebAuthnAbortService.cancelCeremony();

interface Begin<T> {
  ceremonyId: string;
  options: T;
}

/** Browser-side failures (cancelled, timed out, no matching passkey) as an error code the UI translates. */
function browserError(e: unknown): Error {
  const name = (e as { name?: string; cause?: { name?: string } }).cause?.name ?? (e as Error).name;
  const code =
    name === 'AbortError'
      ? 'passkey_aborted'
      : (e as { code?: string }).code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'
        ? 'passkey_exists'
        : 'passkey_cancelled';
  return Object.assign(new Error((e as Error).message ?? String(e)), { code });
}

export const isAborted = (e: unknown) => (e as { code?: string })?.code === 'passkey_aborted';

/** Sign in with a passkey. `email` pins the account (email-first); `autofill` uses conditional mediation. */
export async function signInWithPasskey(
  api: ApiClient,
  opts: { email?: string; autofill?: boolean } = {},
): Promise<Schemas['LoginResponse']> {
  const begin = await api.request<Begin<PublicKeyCredentialRequestOptionsJSON>>(
    'POST',
    '/api/v1/auth/passkeys/login/begin',
    opts.email ? { email: opts.email } : {},
  );
  let credential: AuthenticationResponseJSON;
  try {
    credential = await startAuthentication({
      optionsJSON: begin.options,
      useBrowserAutofill: !!opts.autofill,
    });
  } catch (e) {
    throw browserError(e);
  }
  return api.request<Schemas['LoginResponse']>('POST', '/api/v1/auth/passkeys/login/finish', {
    ceremonyId: begin.ceremonyId,
    credential,
  });
}

/** Create a passkey for the signed-in account. `password` is needed when the session is older than 10 minutes. */
export async function addPasskey(
  api: ApiClient,
  name: string,
  password?: string,
): Promise<Schemas['Passkey']> {
  const begin = await api.request<Begin<PublicKeyCredentialCreationOptionsJSON>>(
    'POST',
    '/api/v1/auth/passkeys/register/begin',
    password ? { password } : {},
  );
  let credential: Awaited<ReturnType<typeof startRegistration>>;
  try {
    credential = await startRegistration({ optionsJSON: begin.options });
  } catch (e) {
    throw browserError(e);
  }
  return api.request<Schemas['Passkey']>('POST', '/api/v1/auth/passkeys/register/finish', {
    ceremonyId: begin.ceremonyId,
    name,
    credential,
  });
}
