// Mapping editor (Features 111, 117, 118): build declarative CSV/TSV/XLSX templates from a sample
// file with a live preview, edit/delete saved ones, import/export template JSON (community
// templates are plain JSON too). Templates are data only, validated by importer-sdk.
import type { TablePreview } from '@finplat/bank-importers';
import { suggestTemplate } from '@finplat/bank-importers';
import {
  type ImportResult,
  type ImportTemplateInput,
  validateTemplate,
} from '@finplat/importer-sdk';
import { Download, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../../lib/i18n.ts';
import { describeError, useLedgerEnv } from '../transactions/data.ts';
import { Button, download, ErrorText, Field, inputCls, MoneyText } from '../transactions/ui.tsx';
import { useDeleteTemplate, useImportSettings, useSaveTemplate } from './store.ts';
import { callWorker } from './worker-types.ts';

type Col = keyof ImportTemplateInput['columns'];
const COLS: { key: Col; label: string; required?: boolean }[] = [
  { key: 'postingDate', label: 'Booking date', required: true },
  { key: 'valueDate', label: 'Value date' },
  { key: 'description', label: 'Description', required: true },
  { key: 'amount', label: 'Amount (signed)' },
  { key: 'debit', label: 'Debit (money out)' },
  { key: 'credit', label: 'Credit (money in)' },
  { key: 'direction', label: 'Direction (D/C column)' },
  { key: 'currency', label: 'Currency' },
  { key: 'reference', label: 'Reference' },
  { key: 'runningBalance', label: 'Running balance' },
  { key: 'counterparty', label: 'Counterparty' },
  { key: 'accountRef', label: 'Account number' },
  { key: 'originalAmount', label: 'Original amount' },
  { key: 'originalCurrency', label: 'Original currency' },
];

const blank = (): ImportTemplateInput => ({
  schemaVersion: 1,
  id: '',
  name: '',
  format: 'csv',
  encoding: 'auto',
  delimiter: 'auto',
  skipRows: 0,
  header: true,
  columns: { postingDate: '', description: '' },
  dateFormat: 'DD.MM.YYYY',
  number: { decimalSeparator: ',', thousandsSeparator: '.' },
  amountSign: 'negative_is_debit',
  skipInvalidRows: true,
});

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'template';

const fmtOf = (name: string): ImportTemplateInput['format'] | null => {
  const e = name.toLowerCase().split('.').pop();
  return e === 'csv' || e === 'txt'
    ? 'csv'
    : e === 'tsv'
      ? 'tsv'
      : e === 'xlsx' || e === 'xls'
        ? 'xlsx'
        : e === 'pdf'
          ? 'pdf'
          : null;
};

export function MappingEditor() {
  const t = useT();
  const { locale } = useLedgerEnv();
  const settings = useImportSettings();
  const save = useSaveTemplate();
  const del = useDeleteTemplate();
  const [tpl, setT] = useState<ImportTemplateInput>(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sample, setSample] = useState<File | null>(null);
  const [preview, setPreview] = useState<TablePreview | null>(null);
  const [test, setTest] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [json, setJson] = useState('');
  const [tried, setTried] = useState(false);

  const up = (p: Partial<ImportTemplateInput>) => setT((x) => ({ ...x, ...p }));
  const setCol = (k: Col, v: string | number | undefined) =>
    setT((x) => {
      const columns = { ...x.columns } as Record<string, unknown>;
      if (v === undefined || v === '') delete columns[k];
      else columns[k] = v;
      return { ...x, columns: columns as ImportTemplateInput['columns'] };
    });

  // Preview rows of the sample (re-read when format/delimiter/encoding/sheet change).
  useEffect(() => {
    if (!sample || (tpl.format !== 'csv' && tpl.format !== 'tsv' && tpl.format !== 'xlsx'))
      return setPreview(null);
    let live = true;
    callWorker({
      kind: 'preview',
      file: sample,
      format: /\.xls$/i.test(sample.name) ? 'xls' : tpl.format,
      delimiter: tpl.delimiter,
      encoding: tpl.encoding,
      sheet: tpl.sheet,
      max: 40,
    })
      .then((r) => live && r.type === 'preview' && setPreview(r.preview))
      .catch((e) => live && setErr(describeError(e)));
    return () => {
      live = false;
    };
  }, [sample, tpl.format, tpl.delimiter, tpl.encoding, tpl.sheet]);

  const skip = tpl.skipRows ?? 0;
  const headerRow = preview?.rows[skip] ?? [];
  const dataRows = preview?.rows.slice(skip + (tpl.header === false ? 0 : 1), skip + 11) ?? [];
  const colOptions =
    tpl.header === false
      ? (preview?.rows[skip] ?? []).map((_, i) => ({ v: i, l: `Column ${i + 1}` }))
      : headerRow.filter(Boolean).map((h) => ({ v: h, l: h }));

  const draft = useMemo(() => ({ ...tpl, id: tpl.id || slug(tpl.name) }), [tpl]);
  const valid = validateTemplate(draft);

  const suggest = () => {
    if (!preview) return;
    const s = suggestTemplate(headerRow, dataRows);
    setT((x) => ({
      ...x,
      columns: { ...(s.columns as unknown as ImportTemplateInput['columns']) },
      ...(s.dateFormat ? { dateFormat: s.dateFormat } : {}),
      ...(s.number ? { number: s.number } : {}),
      detect: headerRow.length
        ? { headerIncludes: Object.values(s.columns).slice(0, 4) }
        : x.detect,
    }));
  };

  const runTest = async () => {
    setErr(null);
    setTest(null);
    if (!sample) return setErr('Choose a sample file first.');
    if (!valid.ok) return setErr('Fix the template issues first.');
    try {
      const imp =
        draft.format === 'pdf'
          ? 'generic-pdf-text'
          : draft.format === 'xlsx' && /\.xls$/i.test(sample.name)
            ? 'generic-xls'
            : `generic-${draft.format}`;
      const r = await callWorker({
        kind: 'parse',
        file: sample,
        importerId: imp,
        template: draft,
        accountCurrency: draft.currency,
      });
      if (r.type === 'parsed') setTest(r.result);
    } catch (e) {
      setErr(describeError(e));
    }
  };

  const submit = async () => {
    setErr(null);
    setMsg(null);
    setTried(true);
    if (!valid.ok)
      return setErr(valid.issues.map((i) => `${i.path || 'template'}: ${i.message}`).join('; '));
    const clash = (settings.data?.templates ?? []).some(
      (x) => x.id === draft.id && x.id !== editingId,
    );
    if (clash) return setErr(`A template with id ${draft.id} exists; change the name or id.`);
    try {
      if (editingId && editingId !== draft.id) await del.mutateAsync(editingId);
      await save.mutateAsync(draft);
      setEditingId(draft.id);
      setMsg('Template saved. Pick it in the Import tab.');
    } catch (e) {
      setErr(describeError(e));
    }
  };

  const loadJson = (text: string) => {
    setErr(null);
    const v = validateTemplate(text);
    if (!v.ok)
      return setErr(
        `Invalid template: ${v.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      );
    setT(JSON.parse(text) as ImportTemplateInput);
    setEditingId(null);
    setJson('');
  };

  const issueFor = (path: string) =>
    valid.ok || !(tried || tpl.name)
      ? undefined
      : valid.issues.find((i) => i.path === path || i.path.startsWith(`${path}.`))?.message;

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <aside className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">
          {t('import.mappingEditor.savedTemplates', 'Saved templates')}
        </h3>
        <ul className="flex flex-col gap-1 text-sm">
          {(settings.data?.templates ?? []).map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-1">
              <button
                type="button"
                className={`truncate text-left ${editingId === x.id ? 'font-semibold' : ''}`}
                onClick={() => {
                  setT(x);
                  setEditingId(x.id);
                  setTest(null);
                }}
              >
                {x.name} <span className="text-xs text-muted">{x.format}</span>
              </button>
              <span className="flex">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('import.mappingEditor.export', 'Export {{name}}', { name: x.name })}
                  onClick={() =>
                    download(
                      `${x.id}.template.json`,
                      JSON.stringify(x, null, 2),
                      'application/json',
                    )
                  }
                >
                  <Download size={12} aria-hidden />
                </Button>
                {settings.data?.community.has(x.id) ? (
                  <span
                    className="text-xs text-muted"
                    title={t(
                      'import.mappingEditor.serverWideTemplateRead',
                      'Server-wide template (read-only)',
                    )}
                  >
                    {t('import.mappingEditor.shared', 'shared')}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('import.mappingEditor.delete', 'Delete {{name}}', {
                      name: x.name,
                    })}
                    onClick={() => window.confirm(`Delete template ${x.name}?`) && del.mutate(x.id)}
                  >
                    <Trash2 size={12} aria-hidden />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          onClick={() => {
            setT(blank());
            setEditingId(null);
            setTest(null);
          }}
        >
          <Plus size={12} aria-hidden /> {t('import.mappingEditor.newTemplate', 'New template')}
        </Button>
        <details>
          <summary className="cursor-pointer text-xs text-muted">
            {t('import.mappingEditor.importTemplateJson', 'Import template JSON')}
          </summary>
          <textarea
            aria-label={t('import.mappingEditor.templateJson', 'Template JSON')}
            rows={6}
            className={`${inputCls} mt-1 h-auto py-1 font-mono text-xs`}
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          <div className="mt-1 flex gap-1">
            <Button size="sm" onClick={() => loadJson(json)} disabled={!json.trim()}>
              {t('import.mappingEditor.load', 'Load')}
            </Button>
            <label className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line px-2 text-xs">
              <Upload size={12} aria-hidden /> {t('import.mappingEditor.file', 'File')}
              <input
                type="file"
                accept=".json,application/json"
                className="sr-only"
                onChange={async (e) =>
                  e.target.files?.[0] && loadJson(await e.target.files[0].text())
                }
              />
            </label>
          </div>
        </details>
      </aside>

      <div className="flex flex-col gap-4">
        <section className="flex flex-wrap items-end gap-2">
          <Field label={t('import.mappingEditor.sampleStatementFile', 'Sample statement file')}>
            {(id) => (
              <input
                id={id}
                type="file"
                accept=".csv,.tsv,.txt,.xlsx,.xls"
                className="text-sm"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setSample(f);
                  setTest(null);
                  const fm = f && fmtOf(f.name);
                  if (fm) up({ format: fm });
                }}
              />
            )}
          </Field>
          <Button size="sm" onClick={suggest} disabled={!preview}>
            {t('import.mappingEditor.suggestMapping', 'Suggest mapping')}
          </Button>
        </section>

        {preview && (
          <div className="max-h-64 overflow-auto rounded-md border border-line">
            <table className="text-xs">
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr
                    // biome-ignore lint/suspicious/noArrayIndexKey: preview rows are positional
                    key={i}
                    className={`border-b border-line ${i < skip ? 'opacity-40' : i === skip && tpl.header !== false ? 'bg-surface-2 font-semibold' : ''}`}
                  >
                    <td className="px-1 text-muted tabular-nums">{i + 1}</td>
                    {r.map((c, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                      <td key={j} className="max-w-48 truncate px-1 whitespace-nowrap">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label={t('import.mappingEditor.templateName', 'Template name')}
            error={issueFor('name')}
          >
            {(id) => (
              <input
                id={id}
                className={inputCls}
                value={tpl.name}
                onChange={(e) => up({ name: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('import.mappingEditor.idSlug', 'Id (slug)')} error={issueFor('id')}>
            {(id) => (
              <input
                id={id}
                className={inputCls}
                placeholder={slug(tpl.name)}
                value={tpl.id}
                onChange={(e) => up({ id: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('import.mappingEditor.bank', 'Bank')}>
            {(id) => (
              <input
                id={id}
                className={inputCls}
                value={tpl.bank?.name ?? ''}
                onChange={(e) =>
                  up({ bank: e.target.value ? { ...tpl.bank, name: e.target.value } : undefined })
                }
              />
            )}
          </Field>
          <Field label={t('import.mappingEditor.format', 'Format')}>
            {(id) => (
              <select
                id={id}
                className={inputCls}
                value={tpl.format}
                onChange={(e) => up({ format: e.target.value as ImportTemplateInput['format'] })}
              >
                <option value="csv">CSV</option>
                <option value="tsv">{t('import.mappingEditor.tsv', 'TSV')}</option>
                <option value="xlsx">{t('import.mappingEditor.xlsxXls', 'XLSX / XLS')}</option>
                <option value="pdf">
                  {t('import.mappingEditor.pdfTableTextPdf', 'PDF table (text PDF)')}
                </option>
              </select>
            )}
          </Field>
          {(tpl.format === 'csv' || tpl.format === 'tsv') && (
            <>
              <Field label={t('import.mappingEditor.encoding', 'Encoding')}>
                {(id) => (
                  <select
                    id={id}
                    className={inputCls}
                    value={tpl.encoding ?? 'auto'}
                    onChange={(e) =>
                      up({ encoding: e.target.value as ImportTemplateInput['encoding'] })
                    }
                  >
                    {['auto', 'utf-8', 'windows-1250', 'iso-8859-2', 'utf-16le', 'utf-16be'].map(
                      (x) => (
                        <option key={x}>{x}</option>
                      ),
                    )}
                  </select>
                )}
              </Field>
              {tpl.format === 'csv' && (
                <Field label={t('import.mappingEditor.delimiter', 'Delimiter')}>
                  {(id) => (
                    <select
                      id={id}
                      className={inputCls}
                      value={tpl.delimiter ?? 'auto'}
                      onChange={(e) =>
                        up({ delimiter: e.target.value as ImportTemplateInput['delimiter'] })
                      }
                    >
                      <option value="auto">{t('import.mappingEditor.auto', 'auto')}</option>
                      <option value=";">;</option>
                      <option value=",">,</option>
                      <option value={'\t'}>{t('import.mappingEditor.tab', 'tab')}</option>
                      <option value="|">|</option>
                    </select>
                  )}
                </Field>
              )}
            </>
          )}
          {tpl.format === 'xlsx' && preview?.sheets && (
            <Field label={t('import.mappingEditor.sheet', 'Sheet')}>
              {(id) => (
                <select
                  id={id}
                  className={inputCls}
                  value={String(tpl.sheet ?? preview.sheets?.[0] ?? '')}
                  onChange={(e) => up({ sheet: e.target.value })}
                >
                  {preview.sheets?.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Field
            label={t('import.mappingEditor.rowsToSkipBefore', 'Rows to skip before the header')}
          >
            {(id) => (
              <input
                id={id}
                type="number"
                min={0}
                max={1000}
                className={inputCls}
                value={skip}
                onChange={(e) => up({ skipRows: Math.max(0, Number(e.target.value) || 0) })}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={tpl.header !== false}
              onChange={(e) =>
                up({
                  header: e.target.checked,
                  columns: { postingDate: '', description: '' } as ImportTemplateInput['columns'],
                })
              }
            />{' '}
            {t('import.mappingEditor.firstRowIsA', 'First row is a header')}
          </label>
        </section>

        <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <legend className="mb-1 text-sm font-semibold">
            {t('import.mappingEditor.columns', 'Columns')}
          </legend>
          {COLS.map((c) => {
            const cur = tpl.columns[c.key];
            const v = Array.isArray(cur) ? cur[0] : cur;
            return (
              <Field
                key={c.key}
                label={`${c.label}${c.required ? ' *' : ''}`}
                error={issueFor(`columns.${c.key}`)}
              >
                {(id) =>
                  colOptions.length ? (
                    <select
                      id={id}
                      className={inputCls}
                      value={v === undefined ? '' : String(v)}
                      onChange={(e) =>
                        setCol(
                          c.key,
                          e.target.value === ''
                            ? undefined
                            : tpl.header === false
                              ? Number(e.target.value)
                              : e.target.value,
                        )
                      }
                    >
                      <option value="">{t('import.mappingEditor.notMapped', 'Not mapped')}</option>
                      {colOptions.map((o) => (
                        <option key={String(o.v)} value={String(o.v)}>
                          {o.l}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={id}
                      className={inputCls}
                      placeholder={
                        tpl.header === false
                          ? t('import.mappingEditor.columnIndex0Based', 'column index (0-based)')
                          : t('import.mappingEditor.headerText', 'header text')
                      }
                      value={v === undefined ? '' : String(v)}
                      onChange={(e) =>
                        setCol(
                          c.key,
                          e.target.value === ''
                            ? undefined
                            : tpl.header === false
                              ? Number(e.target.value)
                              : e.target.value,
                        )
                      }
                    />
                  )
                }
              </Field>
            );
          })}
        </fieldset>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label={t('import.mappingEditor.dateFormat', 'Date format')}
            hint={t('import.mappingEditor.tokensYyyyYyMm', 'Tokens YYYY YY MM M DD D')}
            error={issueFor('dateFormat')}
          >
            {(id, d) => (
              <input
                id={id}
                aria-describedby={d}
                className={inputCls}
                value={tpl.dateFormat}
                onChange={(e) => up({ dateFormat: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('import.mappingEditor.decimalSeparator', 'Decimal separator')}>
            {(id) => (
              <select
                id={id}
                className={inputCls}
                value={tpl.number.decimalSeparator}
                onChange={(e) =>
                  up({ number: { ...tpl.number, decimalSeparator: e.target.value as ',' | '.' } })
                }
              >
                <option value=",">, (1.234,56)</option>
                <option value=".">. (1,234.56)</option>
              </select>
            )}
          </Field>
          <Field
            label={t('import.mappingEditor.thousandsSeparator', 'Thousands separator')}
            error={issueFor('number')}
          >
            {(id) => (
              <select
                id={id}
                className={inputCls}
                value={tpl.number.thousandsSeparator ?? ''}
                onChange={(e) =>
                  up({ number: { ...tpl.number, thousandsSeparator: e.target.value as '' } })
                }
              >
                <option value="">{t('import.mappingEditor.none', 'none')}</option>
                <option value=".">.</option>
                <option value=",">,</option>
                <option value=" ">{t('import.mappingEditor.space', 'space')}</option>
                <option value="'">'</option>
              </select>
            )}
          </Field>
          <Field label={t('import.mappingEditor.amountSign', 'Amount sign')}>
            {(id) => (
              <select
                id={id}
                className={inputCls}
                value={tpl.amountSign ?? 'negative_is_debit'}
                onChange={(e) =>
                  up({ amountSign: e.target.value as ImportTemplateInput['amountSign'] })
                }
              >
                <option value="negative_is_debit">
                  {t('import.mappingEditor.negativeMoneyOut', 'Negative = money out')}
                </option>
                <option value="positive_is_debit">
                  {t('import.mappingEditor.positiveMoneyOut', 'Positive = money out')}
                </option>
              </select>
            )}
          </Field>
          <Field
            label={t('import.mappingEditor.currencyIfTheFile', 'Currency (if the file has none)')}
            error={issueFor('currency')}
          >
            {(id) => (
              <input
                id={id}
                maxLength={3}
                className={`${inputCls} uppercase`}
                value={tpl.currency ?? ''}
                onChange={(e) => up({ currency: e.target.value.toUpperCase() || undefined })}
              />
            )}
          </Field>
          {tpl.columns.direction !== undefined && (
            <>
              <Field
                label={t(
                  'import.mappingEditor.debitValuesCommaSeparated',
                  'Debit values (comma-separated)',
                )}
                error={issueFor('directionValues')}
              >
                {(id) => (
                  <input
                    id={id}
                    className={inputCls}
                    value={tpl.directionValues?.debit.join(',') ?? ''}
                    onChange={(e) =>
                      up({
                        directionValues: {
                          debit: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                          credit: tpl.directionValues?.credit ?? [],
                        },
                      })
                    }
                  />
                )}
              </Field>
              <Field
                label={t(
                  'import.mappingEditor.creditValuesCommaSeparated',
                  'Credit values (comma-separated)',
                )}
              >
                {(id) => (
                  <input
                    id={id}
                    className={inputCls}
                    value={tpl.directionValues?.credit.join(',') ?? ''}
                    onChange={(e) =>
                      up({
                        directionValues: {
                          credit: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                          debit: tpl.directionValues?.debit ?? [],
                        },
                      })
                    }
                  />
                )}
              </Field>
            </>
          )}
          <Field
            label={t(
              'import.mappingEditor.autoDetectHeadersComma',
              'Auto-detect headers (comma-separated)',
            )}
            hint={t(
              'import.mappingEditor.filesWhoseHeaderHas',
              'Files whose header has all of these use this template',
            )}
          >
            {(id, d) => (
              <input
                id={id}
                aria-describedby={d}
                className={inputCls}
                value={tpl.detect?.headerIncludes?.join(', ') ?? ''}
                onChange={(e) => {
                  const h = e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  up({ detect: h.length ? { ...tpl.detect, headerIncludes: h } : undefined });
                }}
              />
            )}
          </Field>
        </section>

        {!valid.ok && (tried || tpl.name) && (
          <ul
            className="text-xs text-warn"
            aria-label={t('import.mappingEditor.templateIssues', 'Template issues')}
          >
            {valid.issues.map((i) => (
              <li key={`${i.path}${i.message}`}>
                {i.path || t('import.mappingEditor.template', 'template')}: {i.message}
              </li>
            ))}
          </ul>
        )}
        <ErrorText error={err} />
        {msg && (
          <p role="status" className="text-sm text-pos">
            {msg}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={runTest} disabled={!sample || !valid.ok}>
            {t('import.mappingEditor.testOnSample', 'Test on sample')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            {t('import.mappingEditor.saveTemplate', 'Save template')}
          </Button>
        </div>

        {test && (
          <section
            aria-label={t('import.mappingEditor.templateTestResult', 'Template test result')}
            className="rounded-md border border-line p-3 text-sm"
          >
            <p className="mb-2">
              {test.records.length} {t('import.mappingEditor.records', 'records,')}{' '}
              {test.errors.length} {t('import.mappingEditor.errors', 'errors,')}{' '}
              {test.warnings.length} {t('import.mappingEditor.warnings', 'warnings.')}
            </p>
            <table className="w-full text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="font-medium">{t('import.mappingEditor.row', 'Row')}</th>
                  <th className="font-medium">{t('transaction.date', 'Date')}</th>
                  <th className="font-medium">{t('transaction.description', 'Description')}</th>
                  <th className="text-right font-medium">{t('transaction.amount', 'Amount')}</th>
                </tr>
              </thead>
              <tbody>
                {test.records.slice(0, 20).map((r) => (
                  <tr key={r.rowNumber} className="border-t border-line">
                    <td>{r.rowNumber}</td>
                    <td className="tabular-nums">{r.postingDate}</td>
                    <td className="truncate">{r.description}</td>
                    <td className="text-right">
                      <MoneyText
                        value={{
                          amount: r.direction === 'debit' ? `-${r.amount}` : r.amount,
                          currency: r.currency,
                        }}
                        locale={locale}
                        signed
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {[...test.errors, ...test.warnings].slice(0, 10).map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: issues have no id
              <p key={i} className="text-xs text-warn">
                {e.row !== undefined && `row ${e.row}: `}
                {e.message}
              </p>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
