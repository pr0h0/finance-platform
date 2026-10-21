// Command palette (Ctrl/Cmd+K or "/") and global shortcuts (N = new expense, I = income,
// T = transfer). Feature 53 quick actions + feature 82 shortcuts for the web.
import { Dialog as RD } from 'radix-ui';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useData } from '../app/data.tsx';
import type { Section } from '../app/routes.tsx';
import { useApp } from '../app/store.ts';
import { cx } from '../components/ui/index.tsx';
import { useT } from '../lib/i18n.ts';
import { lockNow } from './AppLock.tsx';
import { useShell } from './shell-state.ts';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Case/diacritic-insensitive match on every word of the query. Prefix matches rank first. */
export function filterCommands(cmds: Command[], query: string): Command[] {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return cmds;
  return cmds
    .map((c) => ({ c, l: norm(`${c.label} ${c.hint ?? ''}`) }))
    .filter(({ l }) => words.every((w) => l.includes(w)))
    .sort((a, b) => Number(b.l.startsWith(words[0] ?? '')) - Number(a.l.startsWith(words[0] ?? '')))
    .map(({ c }) => c);
}

const typing = (e: globalThis.KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

export function useShortcuts() {
  const { openPalette, openQuickAdd } = useShell.getState();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
        return;
      }
      if (
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        typing(e) ||
        document.querySelector('[role=dialog]')
      )
        return;
      const k = e.key.toLowerCase();
      if (k === '/') {
        e.preventDefault();
        openPalette();
      } else if (k === 'n') {
        e.preventDefault();
        openQuickAdd('expense');
      } else if (k === 'i') {
        e.preventDefault();
        openQuickAdd('income');
      } else if (k === 't') {
        e.preventDefault();
        openQuickAdd('transfer');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette, openQuickAdd]);
}

export function CommandPalette({ sections }: { sections: Section[] }) {
  const t = useT();
  const open = useShell((s) => s.palette);
  const close = useShell((s) => s.closePalette);
  const openQuickAdd = useShell((s) => s.openQuickAdd);
  const navigate = useNavigate();
  const { mode, syncNow } = useData();
  const prefs = useApp((s) => s.prefs);
  const setPrefs = useApp((s) => s.setPrefs);
  const hasLock = useApp((s) => !!s.lock);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => navigate(path);
    const list: Command[] = [
      {
        id: 'new-expense',
        label: t('cmd.newExpense', 'New expense'),
        hint: 'N',
        run: () => openQuickAdd('expense'),
      },
      {
        id: 'new-income',
        label: t('cmd.newIncome', 'New income'),
        hint: 'I',
        run: () => openQuickAdd('income'),
      },
      {
        id: 'new-transfer',
        label: t('cmd.newTransfer', 'New transfer'),
        hint: 'T',
        run: () => openQuickAdd('transfer'),
      },
      {
        id: 'new-planned',
        label: t('cmd.newPlanned', 'New planned transaction'),
        run: go('/planning?new=1'),
      },
      ...sections.map((s) => ({
        id: `go-${s.id}`,
        label: t('cmd.goTo', 'Go to {{section}}', { section: t(s.labelKey, s.label) }),
        run: go(s.path),
      })),
      {
        id: 'theme',
        label: t('cmd.theme', 'Switch theme (now: {{theme}})', { theme: prefs.theme }),
        run: () =>
          setPrefs({
            theme: prefs.theme === 'light' ? 'dark' : prefs.theme === 'dark' ? 'system' : 'light',
          }),
      },
    ];
    if (mode === 'remote')
      list.push({
        id: 'sync',
        label: t('sync.syncNow', 'Sync now'),
        run: () => void syncNow().catch(() => undefined),
      });
    if (hasLock) list.push({ id: 'lock', label: t('shell.lock', 'Lock app'), run: lockNow });
    return list;
  }, [t, sections, navigate, openQuickAdd, prefs.theme, setPrefs, mode, syncNow, hasLock]);

  const results = useMemo(() => {
    const r = filterCommands(commands, q);
    if (q.trim())
      r.push({
        id: 'search-tx',
        label: t('cmd.searchTx', 'Search transactions for “{{q}}”', { q: q.trim() }),
        run: () => navigate(`/transactions?q=${encodeURIComponent(q.trim())}`),
      });
    return r;
  }, [commands, q, t, navigate]);

  useEffect(() => {
    if (!open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const exec = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      exec(results[active]);
    }
  };

  return (
    <RD.Root open={open} onOpenChange={(o) => (o ? undefined : close())}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RD.Content className="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface shadow-xl">
          <RD.Title className="sr-only">{t('shell.palette', 'Command palette')}</RD.Title>
          <RD.Description className="sr-only">
            {t('shell.paletteHelp', 'Type to filter, arrow keys to choose, Enter to run.')}
          </RD.Description>
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
            aria-autocomplete="list"
            aria-label={t('shell.search', 'Search or run a command')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t('shell.search', 'Search or run a command')}
            className="h-11 w-full border-b border-line bg-transparent px-3 text-sm outline-none"
          />
          <div id="palette-list" role="listbox" className="max-h-80 overflow-y-auto p-1">
            {results.map((c, i) => (
              <div
                key={c.id}
                id={`cmd-${c.id}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => exec(c)}
                onKeyDown={() => undefined}
                className={cx(
                  'flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm',
                  i === active && 'bg-surface-2',
                )}
              >
                <span>{c.label}</span>
                {c.hint && <kbd className="text-xs text-muted">{c.hint}</kbd>}
              </div>
            ))}
            {results.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-muted">{t('cmd.none', 'No matches')}</p>
            )}
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
