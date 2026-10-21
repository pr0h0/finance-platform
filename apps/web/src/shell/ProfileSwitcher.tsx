import { Check, ChevronDown } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useData } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import { Badge, Menu } from '../components/ui/index.tsx';
import { useT } from '../lib/i18n.ts';

export function ProfileSwitcher() {
  const t = useT();
  const { profiles, profile, mode, locked } = useData();
  const setApp = useApp((s) => s.set);
  const navigate = useNavigate();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Menu.Root>
        <Menu.Trigger
          className="flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-surface-2"
          aria-label={t('profile.switch', 'Switch profile')}
        >
          <span className="truncate">{profile?.name}</span>
          <span className="text-xs text-muted">{profile?.baseCurrency}</span>
          <ChevronDown className="size-4 shrink-0" aria-hidden />
        </Menu.Trigger>
        <Menu.Content align="start">
          <Menu.Label>{t('profile.profiles', 'Financial profiles')}</Menu.Label>
          {profiles.map((p) => (
            <Menu.Item key={p.id} onSelect={() => setApp({ profileId: p.id })}>
              <Check className={`size-4 ${p.id === profile?.id ? '' : 'invisible'}`} aria-hidden />
              <span className="flex-1 truncate">{p.name}</span>
              {p.privacyMode === 'e2ee' && (
                <Badge tone="accent">E2EE{locked.has(p.id) ? ' · locked' : ''}</Badge>
              )}
              {p.role && p.role !== 'owner' && <Badge>{p.role}</Badge>}
            </Menu.Item>
          ))}
          <Menu.Separator />
          <Menu.Item onSelect={() => navigate('/settings?tab=profiles')}>
            {t('profile.manage', 'Manage profiles…')}
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>
      <span className="hidden sm:inline">
        <Badge tone={mode === 'remote' ? 'accent' : 'neutral'}>
          {mode === 'remote'
            ? t('mode.connectedShort', 'Connected')
            : t('mode.localShort', 'Local')}
        </Badge>
      </span>
    </div>
  );
}
