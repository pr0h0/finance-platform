// Runs the notification generator whenever the profile data changes, and mirrors new items to
// the browser Notification API when the user opted in on this profile and granted permission.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { qk, useFinance, useProfile } from '../../app/data.tsx';
import { useFormat } from '../../lib/format.ts';
import { isNative, nativeNotify } from '../../platform/native.ts';
import { useSnapshot } from '../analytics/hooks.ts';
import { generate } from './generate.ts';

export const BROWSER_SETTING = 'notifications.browser';

/** Browser Notification permission; in the native app OS notifications are always available
 * (permission is asked when they are turned on). */
export const browserSupport = (): NotificationPermission | 'unsupported' =>
  isNative
    ? 'default'
    : typeof Notification === 'undefined'
      ? 'unsupported'
      : Notification.permission;

export function useNotificationGenerator() {
  const ops = useFinance();
  const profile = useProfile();
  const { locale } = useFormat();
  const snap = useSnapshot();
  const qc = useQueryClient();
  const running = useRef(false);
  useEffect(() => {
    const s = snap.data;
    if (!s || running.current) return;
    running.current = true;
    generate(ops, s, locale)
      .then((fresh) => {
        if (!fresh.length) return;
        void qc.invalidateQueries({ queryKey: qk(profile.id, 'insights', 'notifications') });
        if (s.settings[BROWSER_SETTING] !== true) return;
        if (isNative) {
          for (const n of fresh.slice(0, 5)) void nativeNotify(n.title, n.body);
        } else if (browserSupport() === 'granted')
          for (const n of fresh.slice(0, 5)) new Notification(n.title, { body: n.body, tag: n.id });
      })
      .catch(() => undefined)
      .finally(() => {
        running.current = false;
      });
  }, [snap.data, ops, locale, qc, profile.id]);
}
