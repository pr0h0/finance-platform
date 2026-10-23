// App shell: skip link, collapsible sidebar (desktop), top bar (profile, search, quick add,
// sync, notifications, lock), bottom navigation (mobile) and a drawer with every section.
import {
  ChevronsLeft,
  ChevronsRight,
  Lock,
  Menu as MenuIcon,
  MoreHorizontal,
  Plus,
  Search,
} from 'lucide-react';
import { Dialog as RD } from 'radix-ui';
import { type ReactNode, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import type { Section } from '../app/routes.tsx';
import { useApp } from '../app/store.ts';
import { cx, IconButton } from '../components/ui/index.tsx';
import { useT } from '../lib/i18n.ts';
import { LocalMcpListener } from '../mcp/LocalMcp.tsx';
import { isDesktopNative, isNative, onNativeQuickAdd } from '../platform/native.ts';
import { lockNow } from './AppLock.tsx';
import { AutoBackup } from './AutoBackup.tsx';
import { Banners } from './Banners.tsx';
import { CommandPalette, useShortcuts } from './CommandPalette.tsx';
import { NativeUpdatePrompt } from './NativeUpdatePrompt.tsx';
import { NotificationBell } from './NotificationBell.tsx';
import { ProfileSwitcher } from './ProfileSwitcher.tsx';
import { QuickAdd } from './QuickAdd.tsx';
import { SyncIndicator } from './SyncIndicator.tsx';
import { useShell } from './shell-state.ts';
import { UpdatePrompt } from './UpdatePrompt.tsx';

function NavItems({
  sections,
  collapsed,
  onNavigate,
}: {
  sections: Section[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const t = useT();
  const groups: [string, Section[]][] = [
    ['main', sections.filter((s) => s.group === 'main')],
    ['context', sections.filter((s) => s.group === 'context')],
  ];
  return (
    <>
      {groups.map(([g, list]) => (
        <ul
          key={g}
          className={cx(
            'flex flex-col gap-0.5',
            g === 'context' && 'mt-4 border-t border-line pt-4',
          )}
        >
          {list.map((s) => (
            <li key={s.id}>
              <NavLink
                to={s.path}
                end={s.path === '/'}
                onClick={onNavigate}
                title={collapsed ? t(s.labelKey, s.label) : undefined}
                className={({ isActive }) =>
                  cx(
                    'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm',
                    isActive
                      ? 'bg-surface-2 font-medium text-fg'
                      : 'text-muted hover:bg-surface-2 hover:text-fg',
                    collapsed && 'justify-center px-0',
                  )
                }
              >
                <s.icon className="size-4 shrink-0" aria-hidden />
                <span className={cx(collapsed && 'sr-only')}>{t(s.labelKey, s.label)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      ))}
    </>
  );
}

export function Layout({ sections, children }: { sections: Section[]; children: ReactNode }) {
  const t = useT();
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const hasLock = useApp((s) => !!s.lock);
  const setApp = useApp((s) => s.set);
  const [drawer, setDrawer] = useState(false);
  const openPalette = useShell((s) => s.openPalette);
  const openQuickAdd = useShell((s) => s.openQuickAdd);
  const location = useLocation();
  useShortcuts(sections);
  // native desktop: tray menu / global shortcut (Ctrl/Cmd+Shift+E) open quick entry
  useEffect(() => {
    let off: (() => void) | undefined;
    onNativeQuickAdd(() => openQuickAdd('expense')).then((f) => {
      off = f;
    });
    return () => off?.();
  }, [openQuickAdd]);

  // move focus to the page heading after navigation (screen readers announce the new page)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per navigation
  useEffect(() => {
    const h = document.querySelector<HTMLElement>('#main h1');
    if (h) {
      h.tabIndex = -1;
      h.focus({ preventScroll: true });
    }
  }, [location.pathname]);

  const mobile = sections.filter((s) => s.mobile);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        {t('shell.skip', 'Skip to content')}
      </a>

      <aside
        className={cx(
          'sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-surface md:flex',
          collapsed ? 'w-14' : 'w-56',
        )}
      >
        <div
          className={cx(
            'flex h-12 items-center border-b border-line px-3',
            collapsed ? 'justify-center' : 'justify-between',
          )}
        >
          {!collapsed && (
            <span className="text-sm font-semibold">{t('app.name', 'Finance Platform')}</span>
          )}
          <IconButton
            size="sm"
            label={
              collapsed
                ? t('shell.expand', 'Expand sidebar')
                : t('shell.collapse', 'Collapse sidebar')
            }
            onClick={() => setApp({ sidebarCollapsed: !collapsed })}
          >
            {collapsed ? (
              <ChevronsRight className="size-4" aria-hidden />
            ) : (
              <ChevronsLeft className="size-4" aria-hidden />
            )}
          </IconButton>
        </div>
        <nav aria-label={t('shell.nav', 'Main')} className="flex-1 overflow-y-auto p-2">
          <NavItems sections={sections} collapsed={collapsed} />
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* iPhone notch / status bar (native iOS app, iOS home-screen PWA): the inset is 0 elsewhere */}
        <header className="sticky top-0 z-30 flex h-[calc(3rem+env(safe-area-inset-top))] items-center gap-2 border-b border-line bg-surface/95 px-3 pt-[env(safe-area-inset-top)] backdrop-blur">
          <IconButton
            className="md:hidden"
            label={t('shell.menu', 'Menu')}
            onClick={() => setDrawer(true)}
          >
            <MenuIcon className="size-4" aria-hidden />
          </IconButton>
          <ProfileSwitcher />
          <button
            type="button"
            onClick={openPalette}
            className="ml-auto hidden h-8 w-64 items-center gap-2 rounded-md border border-line bg-bg px-2 text-sm text-muted sm:flex"
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Search className="size-4" aria-hidden />
            <span className="flex-1 text-left">{t('shell.search', 'Search or run a command')}</span>
            <kbd className="text-xs">Ctrl K</kbd>
          </button>
          <IconButton
            className="ml-auto sm:hidden"
            label={t('shell.search', 'Search or run a command')}
            onClick={openPalette}
          >
            <Search className="size-4" aria-hidden />
          </IconButton>
          <IconButton
            variant="primary"
            label={t('shell.quickAdd', 'Add transaction (N)')}
            aria-keyshortcuts="N"
            onClick={() => openQuickAdd('expense')}
          >
            <Plus className="size-4" aria-hidden />
          </IconButton>
          <SyncIndicator />
          <NotificationBell />
          {hasLock && (
            <IconButton label={t('shell.lock', 'Lock app')} onClick={lockNow}>
              <Lock className="size-4" aria-hidden />
            </IconButton>
          )}
        </header>

        <Banners />
        {isNative ? <NativeUpdatePrompt /> : <UpdatePrompt />}
        {isDesktopNative() && <AutoBackup />}
        {isDesktopNative() && <LocalMcpListener />}

        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 pb-24 md:pb-6">
          {children}
        </main>
      </div>

      <nav
        aria-label={t('shell.mobileNav', 'Primary')}
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {mobile.map((s) => (
          <NavLink
            key={s.id}
            to={s.path}
            end={s.path === '/'}
            className={({ isActive }) =>
              cx(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]',
                isActive ? 'text-accent' : 'text-muted',
              )
            }
          >
            <s.icon className="size-5" aria-hidden />
            {t(s.labelKey, s.label)}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setDrawer(true)}
          className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-muted"
        >
          <MoreHorizontal className="size-5" aria-hidden />
          {t('shell.more', 'More')}
        </button>
      </nav>

      <RD.Root open={drawer} onOpenChange={setDrawer}>
        <RD.Portal>
          <RD.Overlay className="fixed inset-0 z-40 bg-black/40 md:hidden" />
          <RD.Content className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] overflow-y-auto border-r border-line bg-surface p-3 md:hidden">
            <RD.Title className="mb-3 px-2 text-sm font-semibold">
              {t('app.name', 'Finance Platform')}
            </RD.Title>
            <RD.Description className="sr-only">
              {t('shell.allSections', 'All sections')}
            </RD.Description>
            <nav aria-label={t('shell.allSections', 'All sections')}>
              <NavItems sections={sections} onNavigate={() => setDrawer(false)} />
            </nav>
          </RD.Content>
        </RD.Portal>
      </RD.Root>

      <CommandPalette sections={sections} />
      <QuickAdd />
    </div>
  );
}
