// Sync activation (PLAN §21, features 87, 88, 106, 109): turn this device's local profiles into
// synchronized ones on a server. Steps: server check + trust → sign in → choose profiles (and
// optional end-to-end encryption) → preview with duplicate candidates → upload in recoverable
// batches → verify → only then switch the app to connected mode. A failed verification leaves
// everything local and unchanged. Server migration = disconnect from A, then this flow for B.
import type { Profile } from '@finplat/domain';
import type { ActivationPreview, Keyring, VerifyReport } from '@finplat/sync-client';
import { useState } from 'react';
import { useData } from '../app/data.tsx';
import { useApp } from '../app/store.ts';
import {
  Button,
  Checkbox,
  ErrorBox,
  Field,
  Input,
  Notice,
  tableClass,
} from '../components/ui/index.tsx';
import { useT } from '../lib/i18n.ts';
import {
  AuthStep,
  ServerStep,
  type SignedIn,
  type VerifiedServer,
} from '../onboarding/connect.tsx';

type Step = 'server' | 'auth' | 'choose' | 'preview' | 'done';

interface Prepared {
  profile: Profile;
  keyring?: Keyring;
  preview: ActivationPreview;
  merge: Record<string, string>;
}

export function ActivateFlow({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  const { store, profiles, reload } = useData();
  const setApp = useApp((s) => s.set);
  const [step, setStep] = useState<Step>('server');
  const [server, setServer] = useState<VerifiedServer | null>(null);
  const [signed, setSigned] = useState<SignedIn | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(profiles.map((p) => p.id)));
  const [e2ee, setE2ee] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [prepared, setPrepared] = useState<Prepared[]>([]);
  const [recovery, setRecovery] = useState<{ name: string; code: string }[]>([]);
  const [reports, setReports] = useState<{ name: string; report: VerifyReport }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [progress, setProgress] = useState('');

  async function prepare() {
    if (!signed) return;
    if (e2ee && (pass.length < 10 || pass !== pass2)) {
      setError(
        new Error(
          t(
            'e2ee.passRule',
            'The encryption passphrase needs 10+ characters and both entries must match.',
          ),
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sc = await import('@finplat/sync-client');
      const remote = await signed.api.listProfiles();
      const out: Prepared[] = [];
      const codes: { name: string; code: string }[] = [];
      for (const p of profiles.filter((x) => selected.has(x.id))) {
        setProgress(t('activate.preparing', 'Preparing “{{name}}”…', { name: p.name }));
        let keyring: Keyring | undefined;
        const existing = remote.find((r) => r.id === p.id);
        if (!existing) {
          await signed.api.createProfile({
            id: p.id,
            name: p.name,
            baseCurrency: p.baseCurrency,
            timezone: p.timezone,
            locale: p.locale,
            weekStart: p.weekStart,
            privacyMode: e2ee ? 'e2ee' : 'server_readable',
          });
          if (e2ee) {
            const r = await sc.enableE2ee(signed.api.sync, p.id, {
              passphrase: pass,
              deviceId: signed.deviceId,
              device: await sc.deviceKeyPair(store),
            });
            await sc.saveKeyring(store, p.id, r.keyring);
            keyring = r.keyring;
            codes.push({ name: p.name, code: r.recoveryCode });
          }
        } else if (existing.privacyMode === 'e2ee') {
          keyring = (await sc.loadKeyring(store, p.id)) ?? undefined;
          if (!keyring)
            throw new Error(
              t(
                'activate.locked',
                '“{{name}}” is end-to-end encrypted on the server; unlock it on a device that has its key first.',
                { name: p.name },
              ),
            );
        }
        const preview = await sc.previewActivation(store, signed.api, p.id, p.id, keyring);
        out.push({ profile: p, keyring, preview, merge: {} });
      }
      setPrepared(out);
      setRecovery(codes);
      setStep('preview');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  async function run() {
    if (!signed || !server) return;
    setBusy(true);
    setError(null);
    try {
      const { activate } = await import('@finplat/sync-client');
      const done: { name: string; report: VerifyReport }[] = [];
      for (const p of prepared) {
        setProgress(t('activate.uploading', 'Uploading “{{name}}”…', { name: p.profile.name }));
        const report = await activate({
          store,
          api: signed.api,
          serverUrl: server.baseUrl || location.origin,
          localProfileId: p.profile.id,
          remoteProfileId: p.profile.id,
          deviceId: signed.deviceId,
          keyring: p.keyring,
          merge: p.merge,
        });
        done.push({ name: p.profile.name, report });
      }
      setReports(done);
      setStep('done');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  function finish() {
    if (!signed || !server) return;
    setApp({
      mode: 'remote',
      connection: {
        serverUrl: server.baseUrl,
        deviceId: signed.deviceId,
        email: signed.email,
        ...(signed.token ? { token: signed.token } : {}),
      },
    });
    reload();
  }

  const allOk = reports.length > 0 && reports.every((r) => r.report.ok);

  return (
    <div className="flex flex-col gap-4">
      {step === 'server' && (
        <ServerStep
          onVerified={(s) => {
            setServer(s);
            setStep('auth');
          }}
        />
      )}
      {step === 'auth' && server && (
        <AuthStep
          server={server}
          onSignedIn={async (s) => {
            // An account that already has data: upload nothing new by default (only profiles that
            // already exist there), so connecting a device with test/local data does not push it.
            const remote = await s.api.listProfiles().catch(() => []);
            if (remote.length)
              setSelected(
                new Set(profiles.filter((p) => remote.some((r) => r.id === p.id)).map((p) => p.id)),
              );
            setSigned(s);
            setStep('choose');
          }}
        />
      )}
      {step === 'choose' && (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">
              {t('activate.which', 'Profiles to synchronize')}
            </legend>
            {profiles.map((p) => (
              <Checkbox
                key={p.id}
                checked={selected.has(p.id)}
                onChange={(e) => {
                  const s = new Set(selected);
                  e.target.checked ? s.add(p.id) : s.delete(p.id);
                  setSelected(s);
                }}
                label={`${p.name} (${p.baseCurrency})`}
              />
            ))}
            <p className="text-xs text-muted">
              {t(
                'activate.unselected',
                'Profiles you leave out stay on this device and are hidden while connected; they reappear when you disconnect.',
              )}
            </p>
          </fieldset>
          <div className="rounded-md border border-line p-3">
            <Checkbox
              checked={e2ee}
              onChange={(e) => setE2ee(e.target.checked)}
              label={t('e2ee.enable', 'End-to-end encrypt new server profiles')}
              hint={t(
                'e2ee.explain',
                'The server stores only encrypted data. Analytics and AI features that run on the server are unavailable for this profile.',
              )}
            />
            {e2ee && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label={t('e2ee.passphrase', 'Encryption passphrase')}>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                  />
                </Field>
                <Field label={t('lock.repeat', 'Repeat')}>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={pass2}
                    onChange={(e) => setPass2(e.target.value)}
                  />
                </Field>
                <p className="text-xs text-muted sm:col-span-2">
                  {t(
                    'e2ee.limits',
                    'Keys are kept in this browser’s storage, not a hardware keystore. If you lose the passphrase, the recovery code and every enrolled device, the data cannot be recovered.',
                  )}
                </p>
              </div>
            )}
          </div>
          {selected.size ? (
            <Button
              variant="primary"
              className="self-start justify-self-start"
              busy={busy}
              onClick={prepare}
            >
              {t('activate.preview', 'Preview upload')}
            </Button>
          ) : (
            <>
              <p className="text-sm text-muted">
                {t(
                  'activate.noUpload',
                  'Nothing is uploaded: this device shows the profiles already on the server, and its local profiles stay here, hidden while connected.',
                )}
              </p>
              <Button variant="primary" className="self-start justify-self-start" onClick={finish}>
                {t('activate.connectOnly', 'Connect without uploading')}
              </Button>
            </>
          )}
        </>
      )}
      {step === 'preview' && (
        <>
          {recovery.length > 0 && (
            <Notice tone="warn" role="alert" title={t('e2ee.recoveryCode', 'Recovery code')}>
              <p>
                {t(
                  'e2ee.recoveryCode.warning',
                  'Write this code down and keep it safe. If you lose both the passphrase and this code, your data cannot be recovered.',
                )}
              </p>
              <ul className="mt-2 flex flex-col gap-1 font-mono text-sm break-all text-fg">
                {recovery.map((r) => (
                  <li key={r.name}>
                    {r.name}: {r.code}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {prepared.map((p, i) => (
            <div key={p.profile.id} className="rounded-md border border-line p-3">
              <p className="mb-2 text-sm font-medium">{p.profile.name}</p>
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th>{t('activate.entity', 'Records')}</th>
                      <th>{t('activate.upload', 'To upload')}</th>
                      <th>{t('activate.onServer', 'Already on server')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(p.preview.upload)
                      .filter(([k, n]) => n > 0 || (p.preview.remote[k] ?? 0) > 0)
                      .map(([k, n]) => (
                        <tr key={k}>
                          <td>{k.replace(/_/g, ' ')}</td>
                          <td>{n}</td>
                          <td>{p.preview.remote[k] ?? 0}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {p.preview.duplicates.length > 0 && (
                <fieldset className="mt-3">
                  <legend className="text-sm font-medium">
                    {t('sync.activate.duplicates', 'These look like records already on the server')}
                  </legend>
                  <p className="mb-1 text-xs text-muted">
                    {t(
                      'activate.mergeHint',
                      'Checked items are merged into the server record instead of uploading a second copy.',
                    )}
                  </p>
                  {p.preview.duplicates.map((d) => (
                    <Checkbox
                      key={d.localId}
                      checked={p.merge[d.localId] === d.remoteId}
                      onChange={(e) => {
                        const next = [...prepared];
                        const merge = { ...p.merge };
                        if (e.target.checked) merge[d.localId] = d.remoteId;
                        else delete merge[d.localId];
                        next[i] = { ...p, merge };
                        setPrepared(next);
                      }}
                      label={`${d.entityType}: ${d.label}`}
                    />
                  ))}
                </fieldset>
              )}
            </div>
          ))}
          <Button
            variant="primary"
            className="self-start justify-self-start"
            busy={busy}
            onClick={run}
          >
            {t('activate.start', 'Upload and verify')}
          </Button>
        </>
      )}
      {step === 'done' && (
        <>
          {reports.map(({ name, report }) => (
            <Notice
              key={name}
              tone={report.ok ? 'pos' : 'neg'}
              title={`${name}: ${report.ok ? t('activate.ok', 'verified') : t('activate.failed', 'verification failed')}`}
            >
              {!report.ok && (
                <ul className="list-disc pl-5">
                  {report.missing.length > 0 && (
                    <li>
                      {t('activate.missing', '{{n}} records missing on the server', {
                        n: report.missing.length,
                      })}
                    </li>
                  )}
                  {report.rejected.length > 0 && (
                    <li>
                      {t('activate.rejected', '{{n}} changes refused by the server', {
                        n: report.rejected.length,
                      })}
                      :{' '}
                      {[
                        ...new Set(
                          report.rejected.map(
                            (r) => `${r.entityType} (${r.error?.code ?? 'rejected'})`,
                          ),
                        ),
                      ].join(', ')}
                    </li>
                  )}
                  {report.balanceMismatches.map((m) => (
                    <li key={m.accountId + m.currency}>
                      {t(
                        'activate.balance',
                        'Balance mismatch {{cur}}: local {{l}}, server {{r}}',
                        { cur: m.currency, l: m.local, r: m.remote },
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Notice>
          ))}
          {allOk ? (
            <Button variant="primary" className="self-start justify-self-start" onClick={finish}>
              {t('activate.finish', 'Switch to connected mode')}
            </Button>
          ) : (
            <Notice tone="neutral">
              {t(
                'sync.activate.verifyFailed',
                'Verification failed; sync was not activated. Your local data is unchanged.',
              )}
            </Notice>
          )}
        </>
      )}
      {progress && (
        <p role="status" className="text-sm text-muted">
          {progress}
        </p>
      )}
      <ErrorBox error={error} />
      <Button variant="ghost" className="self-start" onClick={onCancel}>
        {step === 'done' ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
      </Button>
    </div>
  );
}
