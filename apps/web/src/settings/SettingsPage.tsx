import { useSearchParams } from 'react-router';
import { useData } from '../app/data.tsx';
import { PageHeader, Tabs } from '../components/ui/index.tsx';
import { useT } from '../lib/i18n.ts';
import { BackupsTab } from './BackupsTab.tsx';
import { ConnectionTab } from './ConnectionTab.tsx';
import { GeneralTab } from './GeneralTab.tsx';
import { NotificationsTab } from './NotificationsTab.tsx';
import { ProfilesTab } from './ProfilesTab.tsx';
import { SecurityTab } from './SecurityTab.tsx';

export default function SettingsPage() {
  const t = useT();
  const { mode } = useData();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'general';
  return (
    <>
      <PageHeader title={t('settings.title', 'Settings')} />
      <Tabs
        label={t('settings.title', 'Settings')}
        value={tab}
        onValueChange={(v) => setParams({ tab: v }, { replace: true })}
        tabs={[
          { value: 'general', label: t('settings.general', 'General'), content: <GeneralTab /> },
          {
            value: 'profiles',
            label: t('settings.profiles', 'Profiles'),
            content: <ProfilesTab />,
          },
          {
            value: 'security',
            label: t('settings.security', 'Security'),
            content: <SecurityTab />,
          },
          {
            value: 'notifications',
            label: t('settings.notifications', 'Notifications'),
            content: <NotificationsTab />,
          },
          {
            value: 'backups',
            label: t('settings.backups', 'Backups & data'),
            content: <BackupsTab />,
          },
          {
            value: 'connection',
            label:
              mode === 'remote'
                ? t('settings.connection', 'Connection')
                : t('settings.connect', 'Connect to server'),
            content: <ConnectionTab />,
          },
        ]}
      />
    </>
  );
}
