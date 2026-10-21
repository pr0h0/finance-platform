// PWA update behaviour: a new service worker waits until the user chooses to reload, so an
// update never interrupts a form. The SW caches only the app shell (see vite.config.ts).
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from '../components/ui/index.tsx';
import { useT } from '../lib/i18n.ts';

export function UpdatePrompt() {
  const t = useT();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (reg) setInterval(() => reg.update().catch(() => undefined), 60 * 60_000);
    },
  });
  if (!needRefresh && !offlineReady) return null;
  return (
    <div
      role="status"
      className="fixed bottom-20 left-4 z-50 flex max-w-sm items-center gap-3 rounded-md border border-line bg-surface px-3 py-2 text-sm shadow-lg md:bottom-4"
    >
      <span className="flex-1">
        {needRefresh
          ? t('pwa.update', 'A new version is available.')
          : t('pwa.offline', 'The app is ready to work offline.')}
      </span>
      {needRefresh && (
        <Button size="sm" variant="primary" onClick={() => updateServiceWorker(true)}>
          {t('pwa.reload', 'Reload')}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setNeedRefresh(false);
          setOfflineReady(false);
        }}
      >
        {t('common.close', 'Close')}
      </Button>
    </div>
  );
}
