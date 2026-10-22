// Web Push subscription of this browser (connected mode). The service worker shows the messages
// (public/push-sw.js); the server keeps one subscription per browser endpoint.
import type { ApiClient } from '@finplat/api-client';

export const pushSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof PushManager !== 'undefined' &&
  typeof Notification !== 'undefined';

/** Decodes the server's base64url VAPID public key for PushManager.subscribe. */
export function vapidKeyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error('The app is not installed as a service worker yet (reload once).');
  return reg;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  // Without permission there is no subscription; skipping the call also avoids WebKitGTK, whose
  // getSubscription() takes the page down.
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

const sameKey = (sub: PushSubscription, key: Uint8Array): boolean => {
  const cur = sub.options.applicationServerKey;
  if (!cur) return false;
  const a = new Uint8Array(cur);
  return a.length === key.length && a.every((b, i) => b === key[i]);
};

/** Asks for permission, subscribes this browser and registers it with the server. */
export async function subscribePush(api: ApiClient, publicKey: string): Promise<void> {
  if (!pushSupported()) throw new Error('This browser does not support push notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted')
    throw new Error('Notifications are blocked for this site in the browser.');
  const reg = await registration();
  const key = vapidKeyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe(); // subscribed for another server key
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.request('POST', '/api/v1/notifications/push-subscriptions', sub.toJSON());
}

export async function unsubscribePush(api: ApiClient): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.request('DELETE', '/api/v1/notifications/push-subscriptions', {
    endpoint: sub.endpoint,
  });
  await sub.unsubscribe();
}
