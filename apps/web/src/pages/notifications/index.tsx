// Notifications (features 31, 43, 81): budget alerts, bill reminders, shortfalls, trials,
// unusual expenses; mark read; opt in to browser notifications.
import type { Notification as Note } from '@finplat/domain';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useOpsMutation, useOpsQuery, useSnapshot } from '../../features/analytics/hooks.ts';
import { Button, Card, Empty, ErrorText, Loading, Page } from '../../features/analytics/ui.tsx';
import {
  BROWSER_SETTING,
  browserSupport,
  useNotificationGenerator,
} from '../../features/notifications/useNotifications.ts';
import { useFormat } from '../../lib/format.ts';

const tone = { info: 'border-line', warning: 'border-warn/50', critical: 'border-neg/50' } as const;

export default function NotificationsPage() {
  useNotificationGenerator();
  const f = useFormat();
  const snap = useSnapshot();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useOpsQuery(['notifications', unreadOnly], (ops) =>
    ops.listNotifications(unreadOnly),
  );
  const read = useOpsMutation((ops, id: string | undefined) => ops.markNotificationRead(id));
  const setBrowser = useOpsMutation((ops, on: boolean) => ops.setSetting(BROWSER_SETTING, on));
  const [perm, setPerm] = useState(browserSupport());
  const enabled = snap.data?.settings[BROWSER_SETTING] === true;

  const toggleBrowser = async () => {
    if (enabled) return setBrowser.mutate(false);
    if (perm === 'unsupported') return;
    const p = perm === 'granted' ? perm : await Notification.requestPermission();
    setPerm(p);
    if (p === 'granted') setBrowser.mutate(true);
  };

  if (list.error)
    return (
      <Page title="Notifications">
        <ErrorText error={list.error} />
      </Page>
    );
  if (!list.data) return <Loading />;
  const items: Note[] = list.data;
  return (
    <Page
      title="Notifications"
      actions={
        <>
          <Button
            onClick={toggleBrowser}
            disabled={perm === 'unsupported' || perm === 'denied'}
            aria-pressed={enabled}
          >
            {enabled ? (
              <BellOff aria-hidden className="size-4" />
            ) : (
              <Bell aria-hidden className="size-4" />
            )}
            {enabled ? 'Turn off browser notifications' : 'Browser notifications'}
          </Button>
          <Button onClick={() => read.mutate(undefined)} disabled={!items.some((n) => !n.readAt)}>
            <CheckCheck aria-hidden className="size-4" /> Mark all read
          </Button>
        </>
      }
    >
      {perm === 'denied' && (
        <p className="text-sm text-muted">
          Browser notifications are blocked for this site in your browser settings.
        </p>
      )}
      {perm === 'unsupported' && (
        <p className="text-sm text-muted">
          This browser does not support notifications; they are shown here only.
        </p>
      )}
      <div className="flex gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
          />{' '}
          Unread only
        </label>
      </div>
      <Card>
        {items.length ? (
          <ul className="space-y-2">
            {items.map((n) => {
              const link = typeof n.data.link === 'string' ? n.data.link : null;
              return (
                <li
                  key={n.id}
                  className={`rounded-md border-l-4 ${tone[n.severity]} bg-surface p-3 ${n.readAt ? 'opacity-70' : ''}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">
                        {!n.readAt && <span className="sr-only">Unread: </span>}
                        {n.title}
                      </p>
                      <p className="text-sm text-muted">{n.body}</p>
                      <p className="mt-1 text-xs text-muted">
                        {f.dateTime(n.createdAt)} · {n.kind.replace(/_/g, ' ')}
                        {link && (
                          <>
                            {' · '}
                            <Link className="text-accent hover:underline" to={link}>
                              Open
                            </Link>
                          </>
                        )}
                      </p>
                    </div>
                    {!n.readAt && (
                      <Button size="sm" variant="ghost" onClick={() => read.mutate(n.id)}>
                        Mark read
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>
            No notifications. Bill reminders, budget alerts and forecast warnings appear here.
          </Empty>
        )}
      </Card>
      <p className="text-xs text-muted">
        Notifications are created on this device while the app is open. Connected to a server,
        reminders and alerts can also arrive by email or push while the app is closed.{' '}
        <Link className="text-accent hover:underline" to="/settings?tab=notifications">
          Notifications
        </Link>
      </p>
    </Page>
  );
}
