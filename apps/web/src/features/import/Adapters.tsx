// Custom code adapters (Feature 112, PLAN §24): user JavaScript that turns a text statement into
// records, run in a QuickJS sandbox inside the parse worker. Explicit grant per code version.
import {
  ADAPTER_FORMATS,
  DEFAULT_SANDBOX_LIMITS,
  type SourceFormat,
  validateAdapter,
} from '@finplat/importer-sdk';
import { useState } from 'react';
import { useT } from '../../lib/i18n.ts';
import { useLedgerEnv } from '../transactions/data.ts';
import { Badge, Button, Empty, ErrorText, Field, inputCls } from '../transactions/ui.tsx';
import { type StoredAdapter, useAdapters } from './adapters.ts';

const EXAMPLE = `// input = { fileName, text }. Return { records, statements?, warnings? }.
// Amounts are decimal strings: signed ("-12.50"), or a magnitude plus direction "debit"/"credit".
function parse(input) {
  const lines = input.text.trim().split(/\\r?\\n/).slice(1);
  return {
    records: lines.map((l) => {
      const [date, description, amount] = l.split(';');
      return { postingDate: date, description, amount, currency: 'BAM' };
    }),
  };
}
// Optional: confidence 0..1 that this adapter understands the file (head = first 8 KB).
function detect(input) { return input.head.startsWith('date;description;amount') ? 0.8 : 0; }
`;

const blank = (): StoredAdapter => ({
  id: '',
  name: '',
  version: '1.0.0',
  format: 'csv',
  code: EXAMPLE,
});

export function Adapters() {
  const t = useT();
  const { profileId } = useLedgerEnv();
  const { list, granted, save, remove } = useAdapters(profileId);
  const [edit, setEdit] = useState<StoredAdapter | null>(null);
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const grantedIds = new Set(granted.map((a) => a.id));
  const L = DEFAULT_SANDBOX_LIMITS;

  const submit = async (grant: boolean) => {
    if (!edit) return;
    const errs = validateAdapter(edit);
    if (errs.length) return setErr(errs.join('; '));
    await save(edit, grant);
    setEdit(null);
    setAgree(false);
    setErr(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {t(
          'import.adapters.aCustomAdapterIs',
          'A custom adapter is JavaScript you write or paste to read a bank format the bundled importers do not cover. It is stored only on this device for this profile and runs in a sandbox: it receives the text of the file you import with it and nothing else.',
        )}
      </p>
      {list.length === 0 && !edit && (
        <Empty title={t('import.adapters.noCustomAdapters', 'No custom adapters')}>
          {t(
            'import.adapters.bundledImportersAndMapping',
            'Bundled importers and mapping templates cover most banks.',
          )}
        </Empty>
      )}
      {list.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {list.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="font-medium">{a.name}</span>
              <span className="text-xs text-muted">
                {t('import.adapters.custom', 'custom-')}
                {a.id} · {a.version} · {a.format}
              </span>
              {grantedIds.has(a.id) ? (
                <Badge tone="green">{t('import.adapters.allowed', 'allowed')}</Badge>
              ) : (
                <Badge tone="amber">{t('import.adapters.notAllowed', 'not allowed')}</Badge>
              )}
              <span className="ml-auto flex gap-1">
                <Button size="sm" onClick={() => setEdit({ ...a })}>
                  {t('common.edit', 'Edit')}
                </Button>
                {grantedIds.has(a.id) && (
                  <Button size="sm" onClick={() => save({ ...a, grant: undefined }, false)}>
                    {t('auth.revoke', 'Revoke')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => window.confirm(`Delete adapter ${a.name}?`) && remove(a.id)}
                >
                  {t('common.delete', 'Delete')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!edit && (
        <div>
          <Button onClick={() => setEdit(blank())}>
            {t('import.adapters.newAdapter', 'New adapter')}
          </Button>
        </div>
      )}
      {edit && (
        <form
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit(agree);
          }}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Field label={t('profiles.name', 'Name')}>
              {(id) => (
                <input
                  id={id}
                  className={inputCls}
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                />
              )}
            </Field>
            <Field
              label={t('import.adapters.id', 'Id')}
              hint={t('import.adapters.lowercaseDigitsDashes', 'lowercase, digits, dashes')}
            >
              {(id, d) => (
                <input
                  id={id}
                  aria-describedby={d}
                  className={inputCls}
                  value={edit.id}
                  onChange={(e) => setEdit({ ...edit, id: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('admin.version', 'Version')}>
              {(id) => (
                <input
                  id={id}
                  className={inputCls}
                  value={edit.version}
                  onChange={(e) => setEdit({ ...edit, version: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('import.adapters.format', 'Format')}>
              {(id) => (
                <select
                  id={id}
                  className={inputCls}
                  value={edit.format}
                  onChange={(e) => setEdit({ ...edit, format: e.target.value as SourceFormat })}
                >
                  {ADAPTER_FORMATS.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <Field
            label={t('import.adapters.code', 'Code')}
            hint={t(
              'import.adapters.plainScriptDefiningParse',
              'Plain script defining parse(input) and optionally detect(input)',
            )}
          >
            {(id, d) => (
              <textarea
                id={id}
                aria-describedby={d}
                spellCheck={false}
                className={`${inputCls} h-72 font-mono text-xs`}
                value={edit.code}
                onChange={(e) => setEdit({ ...edit, code: e.target.value })}
              />
            )}
          </Field>
          <label className="text-xs">
            {t('import.adapters.loadFromFile', 'Load from file')}{' '}
            <input
              type="file"
              accept=".js,text/javascript,text/plain"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setEdit({ ...edit, code: await f.text() });
              }}
            />
          </label>
          <section
            aria-label={t('mcp.edit', 'Permissions')}
            className="rounded-md border border-line p-3 text-sm"
          >
            <p className="font-medium">
              {t('import.adapters.whatThisAdapterIs', 'What this adapter is allowed to do')}
            </p>
            <ul className="ml-4 list-disc text-xs">
              <li>
                {t(
                  'import.adapters.readTheTextOf',
                  'Read the text of a statement file when you import it with this adapter.',
                )}
              </li>
              <li>
                {t(
                  'import.adapters.returnRecordsWhichAre',
                  'Return records, which are validated (dates, exact decimal amounts, currencies) before staging.',
                )}
              </li>
            </ul>
            <p className="mt-2 font-medium">
              {t('import.adapters.whatItCannotDo', 'What it cannot do')}
            </p>
            <ul className="ml-4 list-disc text-xs">
              <li>
                {t(
                  'import.adapters.noNetworkNoOther',
                  'No network, no other files, no access to this page, your ledger or other profiles.',
                )}
              </li>
              <li>
                {t('import.adapters.stopsAfter', 'Stops after')} {L.timeoutMs / 1000}{' '}
                {t('import.adapters.sOfCpuTime', 's of CPU time or')} {L.memoryBytes / 1024 / 1024}{' '}
                {t('import.adapters.mbOfMemoryFiles', 'MB of memory; files over')}{' '}
                {L.maxInputBytes / 1024 / 1024}{' '}
                {t('import.adapters.mbAreRefused', 'MB are refused.')}
              </li>
            </ul>
            <label className="mt-2 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              {t(
                'import.adapters.iReviewedThisCode',
                'I reviewed this code and allow it to read the statements I import with it. Editing the code later removes this permission.',
              )}
            </label>
          </section>
          <ErrorText error={err} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary">
              {agree
                ? t('import.adapters.saveAndAllow', 'Save and allow')
                : t('import.adapters.saveNotAllowedYet', 'Save (not allowed yet)')}
            </Button>
            <Button
              onClick={() => {
                setEdit(null);
                setErr(null);
                setAgree(false);
              }}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
