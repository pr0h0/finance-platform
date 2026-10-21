import { Bell } from 'lucide-react';
import { Popover } from 'radix-ui';
import { Link } from 'react-router';
import { Button, cx } from '../components/ui/index.tsx';
import { useFormat } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';
import { useMarkRead, useNotifications } from './notifications.ts';

export function NotificationBell() {
  const t = useT();
  const fmt = useFormat();
  const list = useNotifications();
  const mark = useMarkRead();
  const items = list.data ?? [];
  const unread = items.filter((n) => !n.readAt).length;
  const label = unread
    ? t('notif.unread', 'Notifications, {{count}} unread', { count: unread })
    : t('nav.notifications', 'Notifications');
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        title={label}
        className="relative inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-surface-2"
      >
        <Bell className="size-4" aria-hidden />
        {unread > 0 && (
          <span className="absolute top-1 right-1 rounded-full bg-neg px-1 text-[10px] leading-4 text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-sm font-semibold">{t('nav.notifications', 'Notifications')}</h2>
            {unread > 0 && (
              <Button size="sm" variant="ghost" onClick={() => mark.mutate(undefined)}>
                {t('notif.readAll', 'Mark all read')}
              </Button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {items.slice(0, 20).map((n) => (
              <li key={`${n.origin}:${n.id}`} className="border-b border-line last:border-0">
                <button
                  type="button"
                  onClick={() => !n.readAt && mark.mutate(n)}
                  className={cx(
                    'block w-full px-3 py-2 text-left text-sm hover:bg-surface-2',
                    n.readAt && 'opacity-60',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={cx(
                        'size-2 shrink-0 rounded-full',
                        n.severity === 'critical'
                          ? 'bg-neg'
                          : n.severity === 'warning'
                            ? 'bg-warn'
                            : 'bg-accent',
                        n.readAt && 'invisible',
                      )}
                    />
                    <span className="font-medium">{n.title}</span>
                  </span>
                  {n.body && <span className="mt-0.5 block text-muted">{n.body}</span>}
                  <span className="mt-0.5 block text-xs text-muted">
                    {fmt.dateTime(n.createdAt)}
                  </span>
                </button>
              </li>
            ))}
            {items.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted">
                {t('notif.empty', 'No notifications')}
              </li>
            )}
          </ul>
          <Popover.Close asChild>
            <Link
              to="/notifications"
              className="block border-t border-line px-3 py-2 text-center text-sm text-accent"
            >
              {t('notif.all', 'Open notification center')}
            </Link>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
