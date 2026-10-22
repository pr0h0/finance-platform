// Raiffeisen Bank d.d. Bosna i Hercegovina — "IZVOD - OBAVIJEST" PDF statements (Feature 121).
// Layout learned from real statements (see docs/importing/banks/raiffeisen-bih.md); fixtures are
// synthetic (scripts/generate-raiffeisen-fixtures.ts). Rows are rebuilt from text positions instead
// of the generic template path so multi-line descriptions (printed above and below the amounts
// row) stay whole.
import {
  type BankImporter,
  ImportError,
  type ImportInput,
  normalizeCurrency,
  parseAmount,
  parseDate,
  ResultBuilder,
  readAll,
  readHead,
} from '@finplat/importer-sdk';
import { pdfTextItems, type TextItem } from '../../formats/pdf.ts';
import { manifest } from '../../formats/util.ts';

export const raiffeisenBihManifest = manifest({
  id: 'raiffeisen-bih',
  version: '1.0.0',
  name: 'Raiffeisen Bank BiH (PDF izvod)',
  bank: { name: 'Raiffeisen Bank d.d. Bosna i Hercegovina', country: 'BA' },
  formats: ['pdf'],
  status: 'beta',
  limits: { maxBytes: 20 * 1024 * 1024 },
  limitations: [
    'Only the text-layer PDF "IZVOD - OBAVIJEST" account statement; scanned copies need the OCR importer.',
    'The statement carries no transaction references or counterparties; dedup uses date, amount and description.',
    'The "unpaid fees and interest" summary below the table is informational and not imported.',
  ],
});

const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const AMOUNT = /^-?\d{1,3}(,\d{3})*\.\d{2}$/; // printed as 1,234.56
const MARKERS = ['IZVOD - OBAVIJEST', 'Pregled stanja racuna', 'Opis transakcije'];

interface Line {
  page: number;
  y: number;
  items: TextItem[]; // non-empty, sorted by x
}

function toLines(items: readonly TextItem[]): Line[] {
  const sorted = items
    .filter((i) => i.str.trim() !== '')
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const out: Line[] = [];
  for (const it of sorted) {
    const l = out[out.length - 1];
    if (l && l.page === it.page && Math.abs(l.y - it.y) <= 2) l.items.push(it);
    else out.push({ page: it.page, y: it.y, items: [it] });
  }
  for (const l of out) l.items.sort((a, b) => a.x - b.x);
  return out;
}

/** Concatenate fragments, inserting a space where the gap is wider than a narrow glyph. */
function join(items: readonly TextItem[]): string {
  let s = '';
  let end = Number.NEGATIVE_INFINITY;
  for (const it of items) {
    if (s && it.x - end > 0.15 * it.h) s += ' ';
    s += it.str;
    end = it.x + it.w;
  }
  return s.replace(/\s+/g, ' ').trim();
}

const amount = (s: string): string | undefined =>
  AMOUNT.test(s) ? parseAmount(s, { decimalSeparator: '.', thousandsSeparator: ',' }) : undefined;
const date = (s: string) => parseDate(s, 'DD/MM/YYYY');

/** First text below a label in the same column (header blocks print values under their labels). */
function below(items: readonly TextItem[], label: TextItem, maxDy: number, re: RegExp) {
  return items
    .filter(
      (i) =>
        i.page === label.page &&
        Math.abs(i.x - label.x) < 4 &&
        i.y > label.y + 1 &&
        i.y - label.y <= maxDy &&
        re.test(i.str.trim()),
    )
    .sort((a, b) => a.y - b.y)[0]
    ?.str.trim();
}

const isPdf = (h: Uint8Array) => h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46;

async function textItems(input: ImportInput, maxBytes?: number): Promise<TextItem[]> {
  return pdfTextItems(
    await readAll(input, { maxBytes: maxBytes ?? raiffeisenBihManifest.limits?.maxBytes }),
    50,
  );
}

export function isRaiffeisenStatement(items: readonly TextItem[]): boolean {
  const text = toLines(items)
    .map((l) => join(l.items))
    .join('\n');
  return MARKERS.every((m) => text.includes(m)) && /Raiffeisen/i.test(text);
}

/** Parse positioned text of one statement into `out`. Exported for tests. */
export function parseRaiffeisenItems(items: readonly TextItem[], out: ResultBuilder): void {
  const all = items.filter((i) => i.str.trim() !== '');
  const lines = toLines(all);
  const find = (s: string) => all.find((i) => i.str.trim() === s);
  const fail = (what: string): never => {
    throw new ImportError('unrecognized_layout', `Raiffeisen BiH statement: ${what} not found`);
  };

  // Header: account number and IBAN under their labels; balances under "Pocetno"/"Konacno".
  const accLabel = find('Racun:') ?? fail('account number');
  const account = below(all, accLabel, 20, /^\d{6,}$/) ?? fail('account number');
  const ibanLabel = find('IBAN:');
  const iban = ibanLabel ? below(all, ibanLabel, 20, /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/) : undefined;
  const balLabel = (s: string) => all.find((i) => i.page === accLabel.page && i.str.trim() === s);
  const opening = amount(
    below(all, balLabel('Pocetno') ?? fail('opening balance'), 30, AMOUNT) ?? '',
  );
  const closing = amount(
    below(all, balLabel('Konacno') ?? fail('closing balance'), 30, AMOUNT) ?? '',
  );
  if (opening === undefined || closing === undefined) fail('opening/closing balance');
  const period = /period od:\s*(\d{2}\/\d{2}\/\d{4})\s*do:\s*(\d{2}\/\d{2}\/\d{4})/.exec(
    lines.map((l) => join(l.items)).join('\n'),
  );
  const periodStart = period ? date(period[1] as string) : undefined;
  const periodEnd = period ? date(period[2] as string) : undefined;
  // Account currency: the label under "...transakcije u" next to "valuti" (printed "KM").
  const valuti = find('valuti') ?? fail('table header');
  const curLabel = all.find(
    (i) => i.page === valuti.page && Math.abs(i.y - valuti.y) <= 2 && i.x > valuti.x + 10,
  );
  const currency = normalizeCurrency(curLabel?.str ?? '');
  if (!/^[A-Z]{3}$/.test(currency)) fail('account currency');

  const ref = `${account}:${periodStart ?? ''}..${periodEnd ?? ''}`;
  out.statements.push({
    ref,
    accountRef: iban ?? account,
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    openingBalance: opening,
    closingBalance: closing,
    currency,
  });

  // Table columns per page from the header ("Opis transakcije", "Valuta"); a page without a
  // repeated header keeps the previous page's columns.
  let cols: { desc: number; cur: number } | undefined;
  const colsByPage = new Map<number, { desc: number; cur: number }>();
  const pages = [...new Set(lines.map((l) => l.page))];
  for (const p of pages) {
    const d = all.find((i) => i.page === p && i.str.trim() === 'Opis transakcije');
    const c = all.find((i) => i.page === p && i.str.trim() === 'Valuta');
    if (d && c) cols = { desc: d.x - 3, cur: c.x - 3 };
    if (cols) colsByPage.set(p, cols);
  }

  interface Row {
    line: Line;
    desc: TextItem[][];
    cells: string[];
  }
  const rows: Row[] = [];
  const floating: Line[] = [];
  for (const l of lines) {
    const c = colsByPage.get(l.page);
    if (!c) continue;
    const left = l.items.filter((i) => i.x < c.desc).map((i) => i.str.trim());
    const isRow = left.length === 2 && DATE.test(left[0] as string) && DATE.test(left[1] as string);
    const desc = l.items.filter((i) => i.x >= c.desc && i.x < c.cur);
    if (isRow)
      rows.push({
        line: l,
        desc: desc.length ? [desc] : [],
        cells: [...left, ...l.items.filter((i) => i.x >= c.cur).map((i) => i.str.trim())],
      });
    else if (desc.length && desc.length === l.items.length) floating.push(l);
  }
  // Wrapped description lines are vertically centred on their row: attach each to the nearest row.
  for (const f of floating) {
    let best: Row | undefined;
    for (const r of rows)
      if (
        r.line.page === f.page &&
        Math.abs(r.line.y - f.y) <= 12 && // ponytail: fixed line-gap tolerance (rows are ~11pt apart)
        (!best || Math.abs(r.line.y - f.y) < Math.abs(best.line.y - f.y))
      )
        best = r;
    if (best) best.desc.push(f.items);
  }

  rows.forEach((r, n) => {
    const rowNumber = n + 1;
    r.desc.sort((a, b) => (a[0]?.y ?? 0) - (b[0]?.y ?? 0));
    const description = r.desc.map(join).join(' ');
    const [booked, txDate, origCur, origAmt, km, saldo] = r.cells as (string | undefined)[];
    const raw: Record<string, string> = {
      datumObrade: booked ?? '',
      datumTransakcije: txDate ?? '',
      opis: description,
      valuta: origCur ?? '',
      iznosUValuti: origAmt ?? '',
      iznos: km ?? '',
      saldo: saldo ?? '',
    };
    const signedAmount = amount(km ?? '');
    const runningBalance = amount(saldo ?? '');
    const original = amount(origAmt ?? '');
    const postingDate = date(booked ?? '');
    if (r.cells.length !== 6 || !signedAmount || !runningBalance || !postingDate) {
      out.errors.push({
        row: rowNumber,
        code: 'unparsable_row',
        message: `row ${rowNumber}: expected dates, currency and three amounts`,
      });
      return;
    }
    const oc = normalizeCurrency(origCur ?? '');
    const foreign = oc !== currency && original !== undefined && /[1-9]/.test(original);
    out.add({
      rowNumber,
      postingDate,
      valueDate: date(txDate ?? ''),
      signedAmount,
      currency,
      description,
      accountRef: iban ?? account,
      statementRef: ref,
      runningBalance,
      ...(foreign ? { originalAmount: original, originalCurrency: oc } : {}),
      raw,
    });
  });
}

export const raiffeisenBih: BankImporter = {
  manifest: raiffeisenBihManifest,
  async detect(input) {
    if (!isPdf(await readHead(input, 5))) return { confidence: 0 };
    try {
      return isRaiffeisenStatement(await textItems(input))
        ? { confidence: 0.95, format: 'pdf', reason: 'Raiffeisen BiH IZVOD layout' }
        : { confidence: 0 };
    } catch {
      return { confidence: 0 };
    }
  },
  async parse(input, ctx) {
    const out = new ResultBuilder(raiffeisenBihManifest, 'pdf', ctx);
    const items = await textItems(input, ctx.maxBytes);
    if (items.length === 0)
      throw new ImportError(
        'no_text_layer',
        'this PDF has no text layer (scanned?); use the OCR importer',
      );
    if (!isRaiffeisenStatement(items))
      throw new ImportError('unrecognized_layout', 'not a Raiffeisen BiH IZVOD statement');
    parseRaiffeisenItems(items, out);
    return out.finish();
  },
};
