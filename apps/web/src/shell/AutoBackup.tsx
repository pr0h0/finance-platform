// Desktop app: automatic encrypted backups into the folder picked in Settings → Backups & data.
// Checked at start and hourly; a backup is due by the same schedule as the reminder (backup.intervalDays),
// and a done backup also silences the reminder banner.
import type { LocalStore } from '@finplat/storage';
import { useEffect } from 'react';
import { useData } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import { tNow } from '../lib/i18n.ts';
import {
  backupFolder,
  backupPassphrase,
  nativeNotify,
  writeBackupFile,
} from '../platform/native.ts';
import { backupDue } from './Banners.tsx';

/** Writes one backup of every profile when a folder and a passphrase are set; returns its path. */
export async function runAutoBackup(store: LocalStore): Promise<string | null> {
  const [folder, pass] = await Promise.all([backupFolder(), backupPassphrase()]);
  if (!folder || !pass) return null;
  const { exportBackup } = await import('@finplat/sync-client');
  const bytes = await exportBackup(store, pass, {});
  const stamp = new Date().toISOString().slice(0, 16).replace(':', ''); // 2026-10-23T1830
  const path = await writeBackupFile(`finplat-backup-${stamp}.finplat`, bytes);
  const app = useApp.getState();
  app.set({ backup: { ...app.backup, lastBackupAt: new Date().toISOString() } });
  return path;
}

export function AutoBackup() {
  const { store } = useData();
  useEffect(() => {
    let busy = false;
    const tick = async () => {
      const b = useApp.getState().backup;
      if (busy || !backupDue(b.lastBackupAt, b.intervalDays)) return;
      busy = true;
      try {
        await runAutoBackup(store);
      } catch (e) {
        await nativeNotify(
          tNow('autoBackup.failed', 'Automatic backup failed'),
          (e as Error).message ?? String(e),
        ).catch(() => undefined);
      } finally {
        busy = false;
      }
    };
    void tick();
    const id = setInterval(tick, 60 * 60_000);
    return () => clearInterval(id);
  }, [store]);
  return null;
}
