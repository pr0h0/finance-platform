// Template-driven tabular importers: CSV/TSV (streamed), XLSX/XLS (SheetJS), and helpers for the
// mapping editor (preview + suggested template). Templates are validated data (importer-sdk).
import {
  applyTemplate,
  type BankImporter,
  decodeBytes,
  decodeStream,
  type ImportContext,
  ImportError,
  type ImportInput,
  type ImportTemplate,
  parseCsv,
  parseDate,
  ResultBuilder,
  readAll,
  readHead,
  type SourceFormat,
  sniffDelimiter,
  type TableRow,
  type TextEncodingName,
  validateTemplate,
} from '@finplat/importer-sdk';
import * as XLSX from 'xlsx';
import { ext, headText, manifest } from './util.ts';

export function requireTemplate(ctx: ImportContext): ImportTemplate {
  if (ctx.template === undefined)
    throw new ImportError('template_required', 'this importer needs a mapping template');
  const v = validateTemplate(ctx.template);
  if (!v.ok)
    throw new ImportError(
      'invalid_template',
      `invalid template: ${v.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
  return v.template;
}

/** CSV/TSV rows, streamed. Delimiter 'auto' is sniffed from the first 64 KiB. */
export async function* delimitedRows(
  input: ImportInput,
  opts: { delimiter: string; quote?: string; encoding?: TextEncodingName | 'auto' },
  ctx: ImportContext = {},
  enc: { encoding?: TextEncodingName } = {},
): AsyncGenerator<TableRow> {
  let delimiter = opts.delimiter;
  if (delimiter === 'auto')
    delimiter = sniffDelimiter(decodeBytes(await readHead(input), opts.encoding ?? 'auto'));
  yield* parseCsv(decodeStream(input, { ...ctx, encoding: opts.encoding ?? ctx.encoding }, enc), {
    delimiter,
    quote: opts.quote,
  });
}

export function delimitedImporter(format: 'csv' | 'tsv'): BankImporter {
  const m = manifest({
    id: `generic-${format}`,
    version: '1.0.0',
    name: format === 'csv' ? 'CSV (mapping template)' : 'TSV (mapping template)',
    formats: [format],
    status: 'stable',
    requiresTemplate: true,
    limitations: [
      'Needs a mapping template (built in the mapping editor or a community template).',
    ],
  });
  return {
    manifest: m,
    async detect(input) {
      const e = ext(input);
      const head = await headText(input, 4096);
      if (head.includes('\0')) return { confidence: 0 };
      const d = sniffDelimiter(head);
      if (format === 'tsv' && (e === 'tsv' || d === '\t'))
        return { confidence: e === 'tsv' ? 0.6 : 0.45, format };
      if (format === 'csv' && (e === 'csv' || (e === 'txt' && d !== '\t')))
        return { confidence: e === 'csv' ? 0.5 : 0.3, format };
      return { confidence: 0 };
    },
    async parse(input, ctx) {
      const t = requireTemplate(ctx);
      const out = new ResultBuilder(m, format, ctx);
      const enc: { encoding?: TextEncodingName } = {};
      const delimiter = format === 'tsv' ? '\t' : t.delimiter;
      const rows = delimitedRows(
        input,
        { delimiter, quote: t.quote, encoding: ctx.encoding ?? t.encoding },
        ctx,
        enc,
      );
      await applyTemplate(t, rows, out, ctx.accountCurrency);
      out.encoding = enc.encoding;
      return out.finish();
    },
  };
}

// ---- spreadsheets ----

/**
 * Excel stores numbers as IEEE doubles and itself shows at most 15 significant digits, so a cell is
 * rendered with 15 significant digits (removing binary noise like 0.30000000000000004) as a plain
 * decimal string. This is the only place a float is ever turned into money text.
 */
export function excelNumberText(v: number): string {
  if (!Number.isFinite(v)) return '';
  let s = String(Number(v.toPrecision(15)));
  if (/e/i.test(s))
    s = Number(v.toPrecision(15))
      .toFixed(12)
      .replace(/\.?0+$/, '');
  return s;
}

function formatDate(y: number, mo: number, d: number, fmt: string): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return fmt.replace(/YYYY|YY|MM|M|DD|D/g, (t) =>
    t === 'YYYY'
      ? String(y)
      : t === 'YY'
        ? p2(y % 100)
        : t === 'MM'
          ? p2(mo)
          : t === 'M'
            ? String(mo)
            : t === 'DD'
              ? p2(d)
              : String(d),
  );
}

export interface SheetOptions {
  sheet?: string | number;
  dateFormat: string;
  decimalSeparator: '.' | ',';
}

export function readWorkbook(bytes: Uint8Array): XLSX.WorkBook {
  // No formulas evaluation, no external links; SheetJS only parses.
  return XLSX.read(bytes, {
    type: 'array',
    cellNF: true,
    cellFormula: false,
    cellHTML: false,
    dense: false,
  });
}

/** Typed cells → text the template engine understands (dates in dateFormat, numbers with the decimal mark). */
export function* sheetRows(wb: XLSX.WorkBook, o: SheetOptions): Generator<TableRow> {
  const name = typeof o.sheet === 'number' ? wb.SheetNames[o.sheet] : (o.sheet ?? wb.SheetNames[0]);
  const ws = name !== undefined ? wb.Sheets[name] : undefined;
  if (!ws) throw new ImportError('missing_sheet', `sheet ${String(o.sheet ?? 0)} not found`);
  const ref = ws['!ref'];
  if (!ref) return;
  const r = XLSX.utils.decode_range(ref);
  for (let R = r.s.r; R <= r.e.r; R++) {
    const cells: string[] = [];
    for (let C = r.s.c; C <= r.e.c; C++) {
      const c = ws[XLSX.utils.encode_cell({ r: R, c: C })] as XLSX.CellObject | undefined;
      cells.push(c ? cellText(c, o) : '');
    }
    yield { line: R + 1, cells };
  }
}

function cellText(c: XLSX.CellObject, o: SheetOptions): string {
  if (c.t === 'n' && typeof c.v === 'number') {
    if (c.z !== undefined && XLSX.SSF.is_date(c.z)) {
      const d = XLSX.SSF.parse_date_code(c.v);
      return formatDate(d.y, d.m, d.d, o.dateFormat);
    }
    const s = excelNumberText(c.v);
    return o.decimalSeparator === ',' ? s.replace('.', ',') : s;
  }
  if (c.t === 'd' && c.v instanceof Date) {
    return formatDate(c.v.getUTCFullYear(), c.v.getUTCMonth() + 1, c.v.getUTCDate(), o.dateFormat);
  }
  if (c.t === 'b') return c.v ? 'TRUE' : 'FALSE';
  if (c.t === 'e') return '';
  return c.v == null ? '' : String(c.v);
}

async function* iter<T>(g: Iterable<T>): AsyncGenerator<T> {
  yield* g;
}

export function spreadsheetImporter(format: 'xlsx' | 'xls'): BankImporter {
  const m = manifest({
    id: `generic-${format}`,
    version: '1.0.0',
    name:
      format === 'xlsx' ? 'Excel XLSX (mapping template)' : 'Excel 97-2003 XLS (mapping template)',
    formats: [format],
    status: format === 'xlsx' ? 'stable' : 'beta',
    requiresTemplate: true,
    limits: { maxBytes: 30 * 1024 * 1024 },
    limitations: [
      'The workbook is loaded fully in memory (max 30 MB).',
      'Formula cells use the value cached by the spreadsheet application; nothing is recalculated.',
      ...(format === 'xls'
        ? ['Legacy BIFF .xls is parsed by SheetJS; password-protected files are not supported.']
        : []),
    ],
  });
  return {
    manifest: m,
    async detect(input) {
      const h = await readHead(input, 8);
      const zip = h[0] === 0x50 && h[1] === 0x4b;
      const ole = h[0] === 0xd0 && h[1] === 0xcf && h[2] === 0x11 && h[3] === 0xe0;
      const e = ext(input);
      if (format === 'xlsx' && zip && (e === 'xlsx' || e === 'xlsm'))
        return { confidence: 0.9, format };
      if (format === 'xlsx' && zip) return { confidence: 0.3, format };
      if (format === 'xls' && ole) return { confidence: e === 'xls' ? 0.9 : 0.5, format };
      return { confidence: 0 };
    },
    async parse(input, ctx) {
      const t = requireTemplate(ctx);
      const out = new ResultBuilder(m, format, ctx);
      const wb = readWorkbook(
        await readAll(input, { ...ctx, maxBytes: ctx.maxBytes ?? m.limits?.maxBytes }),
      );
      const rows = sheetRows(wb, {
        sheet: t.sheet,
        dateFormat: t.dateFormat,
        decimalSeparator: t.number.decimalSeparator,
      });
      await applyTemplate(t, iter(rows), out, ctx.accountCurrency);
      return out.finish();
    },
  };
}

// ---- mapping editor support (Feature 117) ----

export interface TablePreview {
  rows: string[][];
  delimiter?: string;
  encoding?: TextEncodingName;
  sheets?: string[];
}

/** First `max` rows of a delimited file or sheet, for the mapping editor. Dates in sheets show as YYYY-MM-DD. */
export async function readTablePreview(
  input: ImportInput,
  opts: {
    format: SourceFormat;
    delimiter?: string;
    encoding?: TextEncodingName | 'auto';
    sheet?: string | number;
  },
  max = 30,
): Promise<TablePreview> {
  const rows: string[][] = [];
  if (opts.format === 'xlsx' || opts.format === 'xls') {
    const wb = readWorkbook(await readAll(input));
    for (const r of sheetRows(wb, {
      sheet: opts.sheet,
      dateFormat: 'YYYY-MM-DD',
      decimalSeparator: '.',
    })) {
      rows.push(r.cells);
      if (rows.length >= max) break;
    }
    return { rows, sheets: wb.SheetNames };
  }
  const head = await readHead(input);
  const delimiter =
    opts.format === 'tsv'
      ? '\t'
      : opts.delimiter && opts.delimiter !== 'auto'
        ? opts.delimiter
        : sniffDelimiter(decodeBytes(head, opts.encoding ?? 'auto'));
  const enc: { encoding?: TextEncodingName } = {};
  for await (const r of delimitedRows(input, { delimiter, encoding: opts.encoding }, {}, enc)) {
    rows.push(r.cells);
    if (rows.length >= max) break;
  }
  return { rows, delimiter, encoding: enc.encoding };
}

const SYNONYMS: Record<string, string[]> = {
  postingDate: [
    'date',
    'booking date',
    'posting date',
    'transaction date',
    'datum',
    'datum knjiženja',
    'datum transakcije',
    'buchungstag',
    'buchungsdatum',
  ],
  valueDate: ['value date', 'valuta', 'datum valute', 'wertstellung'],
  description: [
    'description',
    'details',
    'memo',
    'opis',
    'opis transakcije',
    'svrha',
    'svrha plaćanja',
    'verwendungszweck',
    'text',
  ],
  amount: ['amount', 'iznos', 'betrag', 'value'],
  debit: ['debit', 'withdrawal', 'out', 'duguje', 'isplata', 'teret', 'soll'],
  credit: ['credit', 'deposit', 'in', 'potražuje', 'uplata', 'korist', 'haben'],
  currency: ['currency', 'valuta iznosa', 'ccy', 'währung', 'waehrung'],
  reference: ['reference', 'ref', 'referenca', 'transaction id', 'id', 'broj naloga'],
  runningBalance: ['balance', 'running balance', 'saldo', 'stanje', 'kontostand'],
  counterparty: [
    'counterparty',
    'payee',
    'beneficiary',
    'primalac',
    'primatelj',
    'platilac',
    'naziv',
    'empfänger',
  ],
};

const DATE_GUESSES = [
  'DD.MM.YYYY',
  'D.M.YYYY',
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD-MM-YYYY',
  'DD.MM.YY',
  'YYYY.MM.DD',
  'YYYY/MM/DD',
];

/**
 * Best-effort starting point for the mapping editor from a header row and sample rows. Always
 * shown to the user for review; never applied silently.
 */
export interface TemplateSuggestion {
  columns: Record<string, string>;
  dateFormat?: string;
  number?: ImportTemplate['number'];
}

export function suggestTemplate(header: string[], samples: string[][]): TemplateSuggestion {
  const columns: Record<string, string> = {};
  const used = new Set<number>();
  for (const [field, words] of Object.entries(SYNONYMS)) {
    const i = header.findIndex(
      (h, idx) => !used.has(idx) && words.includes(h.trim().toLowerCase()),
    );
    if (i >= 0) {
      columns[field] = header[i] as string;
      used.add(i);
    }
  }
  const out: TemplateSuggestion = { columns };
  const dateCol = columns.postingDate ? header.indexOf(columns.postingDate) : -1;
  if (dateCol >= 0) {
    const vals = samples.map((r) => r[dateCol] ?? '').filter(Boolean);
    const fmt = DATE_GUESSES.find(
      (f) => vals.length > 0 && vals.every((v) => parseDate(v, f) !== undefined),
    );
    if (fmt) out.dateFormat = fmt;
  }
  const amountCols = ['amount', 'debit', 'credit', 'runningBalance']
    .map((k) => (columns[k] ? header.indexOf(columns[k]) : -1))
    .filter((i) => i >= 0);
  const amounts = samples.flatMap((r) => amountCols.map((i) => r[i] ?? '')).filter(Boolean);
  const commaDecimal = amounts.some((a) => /,\d{1,2}$/.test(a.trim()));
  const dotDecimal = amounts.some((a) => /\.\d{1,2}$/.test(a.trim()));
  if (commaDecimal !== dotDecimal) {
    const dec = commaDecimal ? ',' : '.';
    const thou = amounts.some((a) => (dec === ',' ? /\d\.\d{3}/ : /\d,\d{3}/).test(a))
      ? dec === ','
        ? '.'
        : ','
      : '';
    out.number = { decimalSeparator: dec, thousandsSeparator: thou };
  }
  return out;
}
