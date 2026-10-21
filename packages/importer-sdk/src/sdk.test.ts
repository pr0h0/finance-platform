import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMPORTS_DIR } from '@finplat/test-fixtures';
import {
  applyTemplate,
  canonicalAmount,
  canonicalDescription,
  checkRunningBalances,
  checkStatementBalance,
  computeCoverage,
  decodeBytes,
  decodeStream,
  detectEncoding,
  fingerprint,
  fingerprintAll,
  IMPORTER_SDK_VERSION,
  ImporterRegistry,
  inputFromBytes,
  lines,
  matchExisting,
  monthlyCoverage,
  type NormalizedRecord,
  parseAmount,
  parseCsv,
  parseDate,
  ResultBuilder,
  readAll,
  sniffDelimiter,
  totals,
  validateTemplate,
} from './index.ts';

const enc = new TextEncoder();
async function* chunked(s: string, size: number) {
  for (let i = 0; i < s.length; i += size) yield s.slice(i, i + size);
}
async function collect<T>(g: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}
const manifest = {
  id: 't',
  version: '1.0.0',
  sdkVersion: 1,
  name: 't',
  formats: ['csv' as const],
  status: 'stable' as const,
};

describe('encoding', () => {
  const sample = 'Šećer ž đ č ć';
  test('BOM and UTF-8', () => {
    expect(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toMatchObject({
      encoding: 'utf-8',
      bomLength: 3,
    });
    expect(detectEncoding(enc.encode(sample)).encoding).toBe('utf-8');
    expect(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0])).encoding).toBe('utf-16le');
  });
  test('windows-1250 vs iso-8859-2', () => {
    // š = 0x9A in 1250, 0xB9 in 8859-2
    expect(detectEncoding(new Uint8Array([0x9a, 0x65, 0x9e])).encoding).toBe('windows-1250');
    expect(detectEncoding(new Uint8Array([0xb9, 0x65, 0xbe])).encoding).toBe('iso-8859-2');
    expect(decodeBytes(new Uint8Array([0x9a, 0xe8]))).toBe('šč');
    expect(decodeBytes(new Uint8Array([0xb9, 0xe8]))).toBe('šč');
  });
  test('stream decoding across a split multi-byte char', async () => {
    const bytes = enc.encode('ab€cd'.repeat(30000)); // > 64 KiB so streaming kicks in
    const input = inputFromBytes('x.txt', bytes);
    const out = { encoding: undefined as string | undefined };
    const text = (await collect(decodeStream(input, {}, out as never))).join('');
    expect(text).toBe('ab€cd'.repeat(30000));
    expect(out.encoding).toBe('utf-8');
  });
  test('lines handles CRLF split across chunks', async () => {
    expect(await collect(lines(chunked('a\r\nb\rc\nd', 1)))).toEqual(['a', 'b', 'c', 'd']);
    expect(await collect(lines(chunked('a\r', 1)))).toEqual(['a']);
  });
});

describe('csv', () => {
  test('quotes, escaped quotes, embedded newlines, chunked input', async () => {
    const src = 'a;b;c\r\n"x;1";"he said ""hi""";"multi\nline"\n\n1;;3';
    for (const size of [1, 3, 1000]) {
      const rows = await collect(parseCsv(chunked(src, size), { delimiter: ';' }));
      expect(rows.map((r) => r.cells)).toEqual([
        ['a', 'b', 'c'],
        ['x;1', 'he said "hi"', 'multi\nline'],
        ['1', '', '3'],
      ]);
      expect(rows.map((r) => r.line)).toEqual([1, 2, 5]);
    }
  });
  test('delimiter sniffing', () => {
    expect(sniffDelimiter('a;b;c\n1;2,5;3\n')).toBe(';');
    expect(sniffDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(sniffDelimiter('a\tb\n1\t2\n')).toBe('\t');
  });
});

describe('values', () => {
  test('dates', () => {
    expect(parseDate('05.01.2025', 'DD.MM.YYYY')).toBe('2025-01-05');
    expect(parseDate('5.1.2025', 'D.M.YYYY')).toBe('2025-01-05');
    expect(parseDate('01/05/25', 'MM/DD/YY')).toBe('2025-01-05');
    expect(parseDate('2025-01-05T10:00:00Z', 'YYYY-MM-DD')).toBe('2025-01-05');
    expect(parseDate('05.01.2025 10:22', 'DD.MM.YYYY')).toBe('2025-01-05');
    expect(parseDate('29.02.2024', 'DD.MM.YYYY')).toBe('2024-02-29');
    expect(parseDate('29.02.2025', 'DD.MM.YYYY')).toBeUndefined();
    expect(parseDate('13/01/2025', 'MM/DD/YYYY')).toBeUndefined();
    expect(parseDate('Ukupno', 'DD.MM.YYYY')).toBeUndefined();
    expect(() => parseDate('x', 'DD.(MM)')).toThrow();
  });
  test('amounts never go through floats', () => {
    const eu = { decimalSeparator: ',', thousandsSeparator: '.' } as const;
    expect(parseAmount('1.234,56', eu)).toBe('1234.56');
    expect(parseAmount('-1.234,56', eu)).toBe('-1234.56');
    expect(parseAmount('12,00-', eu)).toBe('-12.00');
    expect(parseAmount('(5,10)', eu)).toBe('-5.10');
    expect(parseAmount('0,00', eu)).toBe('0.00');
    expect(parseAmount('-0,00', eu)).toBe('0.00');
    expect(
      parseAmount('12.3.4', { decimalSeparator: '.', thousandsSeparator: '' }),
    ).toBeUndefined();
    expect(parseAmount('1 234 567,89', { decimalSeparator: ',', thousandsSeparator: ' ' })).toBe(
      '1234567.89',
    );
    expect(parseAmount("1'000.05", { decimalSeparator: '.', thousandsSeparator: "'" })).toBe(
      '1000.05',
    );
    expect(
      parseAmount('99999999999999999.99', { decimalSeparator: '.', thousandsSeparator: '' }),
    ).toBe('99999999999999999.99');
  });
});

describe('fingerprint (shared vectors with Go)', () => {
  const vectors = JSON.parse(readFileSync(join(IMPORTS_DIR, 'fingerprint.json'), 'utf8')) as {
    name: string;
    input: Parameters<typeof fingerprint>[0];
    ordinal: number;
    expected: string;
  }[];
  for (const v of vectors)
    test(v.name, async () => expect(await fingerprint(v.input, v.ordinal)).toBe(v.expected));
  test('canonical parts', () => {
    expect(canonicalAmount('0150.00', 'debit')).toBe('-150');
    expect(canonicalAmount('0.00', 'debit')).toBe('0');
    expect(canonicalDescription('Ａｂｃ  1-2')).toBe('abc12'); // NFKC folds full-width
  });
  test('ordinals keep identical rows distinct but stable', async () => {
    const r = {
      postingDate: '2025-01-03',
      amount: '3.50',
      direction: 'debit' as const,
      currency: 'EUR',
      description: 'Coffee',
    };
    const a = await fingerprintAll([r, r]);
    const b = await fingerprintAll([r, r]);
    expect(a[0]).not.toBe(a[1]);
    expect(a).toEqual(b);
  });
});

const T = {
  schemaVersion: 1,
  id: 'test-csv',
  name: 'Test',
  format: 'csv',
  delimiter: ';',
  columns: {
    postingDate: 'Datum',
    description: 'Opis',
    debit: 'Duguje',
    credit: 'Potražuje',
    runningBalance: 'Stanje',
  },
  dateFormat: 'DD.MM.YYYY',
  number: { decimalSeparator: ',', thousandsSeparator: '.' },
  currency: 'BAM',
};

describe('template validation (data only)', () => {
  test('valid template gets defaults', () => {
    const v = validateTemplate(T);
    expect(v.ok).toBe(true);
    if (v.ok)
      expect(v.template).toMatchObject({
        skipRows: 0,
        header: true,
        encoding: 'auto',
        templateVersion: '1.0.0',
      });
  });
  test('rejects unknown keys, code-like values and bad formats', () => {
    for (const bad of [
      { ...T, transform: 'return 1' },
      { ...T, columns: { ...T.columns, script: 'x' } },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing template-injection text
      { ...T, dateFormat: '${process.exit()}' },
      { ...T, dateFormat: '(\\d+)+$' },
      { ...T, delimiter: 'abc' },
      { ...T, id: '../../etc' },
      { ...T, currency: 'XYZ' },
      { ...T, number: { decimalSeparator: ',', thousandsSeparator: ',' } },
      { ...T, columns: { postingDate: 'Datum', description: 'Opis' } },
      { ...T, columns: { ...T.columns, amount: 'Iznos' } },
      { ...T, header: false },
      { ...T, schemaVersion: 2 },
      JSON.parse(`{"__proto__":{"polluted":true},"schemaVersion":1}`),
    ]) {
      expect(validateTemplate(bad).ok).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(validateTemplate('not json').ok).toBe(false);
    expect(validateTemplate('x'.repeat(40_000)).ok).toBe(false);
  });
});

async function runTemplate(csv: string, tpl: object = T) {
  const v = validateTemplate(tpl);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  const out = new ResultBuilder(manifest, 'csv', {});
  await applyTemplate(v.template, parseCsv(chunked(csv, 7), { delimiter: ';' }), out);
  return out.finish();
}

describe('applyTemplate', () => {
  test('debit/credit columns, footer skipped, balances', async () => {
    const r = await runTemplate(
      'Datum;Opis;Duguje;Potražuje;Stanje\n02.01.2025;Kupovina;45,20;;954,80\n03.01.2025;Plata;;1.000,00;1.954,80\nUkupno;;45,20;1.000,00;\n',
    );
    expect(
      r.records.map((x) => [x.postingDate, x.direction, x.amount, x.currency, x.runningBalance]),
    ).toEqual([
      ['2025-01-02', 'debit', '45.20', 'BAM', '954.80'],
      ['2025-01-03', 'credit', '1000.00', 'BAM', '1954.80'],
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(['invalid_date']);
    expect(r.records[0]?.fingerprint).toMatch(/^fp1:[0-9a-f]{64}$/);
    expect(r.records[0]?.raw).toEqual({
      Datum: '02.01.2025',
      Opis: 'Kupovina',
      Duguje: '45,20',
      Potražuje: '',
      Stanje: '954,80',
    });
  });
  test('errors: missing column, both sides filled, precision, unknown currency', async () => {
    const missing = await runTemplate('Date;Opis\n01.01.2025;x\n');
    expect(missing.errors[0]?.code).toBe('missing_column');
    const r = await runTemplate(
      'Datum;Opis;Duguje;Potražuje;Stanje\n02.01.2025;a;1,00;2,00;\n02.01.2025;b;1,001;;\n02.01.2025;c;x;;\n',
    );
    expect(r.errors.map((e) => e.code)).toEqual([
      'ambiguous_amount',
      'amount_precision',
      'invalid_amount',
    ]);
    const cur = await runTemplate('Datum;Opis;Duguje\n02.01.2025;a;1,00\n', {
      ...T,
      currency: undefined,
      columns: { postingDate: 'Datum', description: 'Opis', debit: 'Duguje' },
    });
    expect(cur.errors.map((e) => e.code)).toEqual(['missing_currency']);
  });
  test('skipInvalidRows:false turns bad dates into errors', async () => {
    const r = await runTemplate('Datum;Opis;Duguje\n31.02.2025;a;1,00\n', {
      ...T,
      skipInvalidRows: false,
      columns: { postingDate: 'Datum', description: 'Opis', debit: 'Duguje' },
    });
    expect(r.errors.map((e) => e.code)).toEqual(['invalid_date']);
    expect(r.confidence).toBe(0);
  });
  test('row limit', async () => {
    const v = validateTemplate({
      ...T,
      columns: { postingDate: 'Datum', description: 'Opis', debit: 'Duguje' },
    });
    if (!v.ok) throw new Error();
    const out = new ResultBuilder(manifest, 'csv', { maxRows: 1 });
    const csv = 'Datum;Opis;Duguje\n01.01.2025;a;1,00\n02.01.2025;b;1,00\n';
    await expect(
      applyTemplate(v.template, parseCsv(chunked(csv, 5), { delimiter: ';' }), out),
    ).rejects.toThrow('more than 1 rows');
  });
});

function rec(p: Partial<NormalizedRecord>): NormalizedRecord {
  return {
    rowNumber: 1,
    postingDate: '2025-01-01',
    description: '',
    direction: 'debit',
    amount: '1.00',
    currency: 'BAM',
    raw: {},
    fingerprint: '',
    confidence: 1,
    warnings: [],
    ...p,
  };
}

describe('reconciliation', () => {
  const rs = [
    rec({
      rowNumber: 1,
      direction: 'credit',
      amount: '100.00',
      runningBalance: '1100.00',
      postingDate: '2025-01-02',
    }),
    rec({ rowNumber: 2, amount: '0.10', runningBalance: '1099.90', postingDate: '2025-01-03' }),
    rec({ rowNumber: 3, amount: '0.20', runningBalance: '1099.70', postingDate: '2025-01-04' }),
  ];
  test('totals are exact', () => {
    expect(totals(rs)).toEqual([
      {
        currency: 'BAM',
        income: { amount: '100.00', currency: 'BAM' },
        expenses: { amount: '0.30', currency: 'BAM' },
        net: { amount: '99.70', currency: 'BAM' },
        count: 3,
      },
    ]);
  });
  test('statement balance', () => {
    expect(
      checkStatementBalance(
        { openingBalance: '1000.00', closingBalance: '1099.70', currency: 'BAM' },
        rs,
      ).status,
    ).toBe('balanced');
    const bad = checkStatementBalance(
      { openingBalance: '1000', closingBalance: '1099.80', currency: 'BAM' },
      rs,
    );
    expect(bad).toMatchObject({
      status: 'mismatch',
      difference: { amount: '0.10', currency: 'BAM' },
    });
    expect(checkStatementBalance({}, rs).status).toBe('unverifiable');
  });
  test('running balances in either order derive opening balance (Feature 129)', () => {
    const fwd = checkRunningBalances(rs);
    expect(fwd).toMatchObject({
      order: 'oldest_first',
      breaks: [],
      openingBalance: { amount: '1000.00' },
      closingBalance: { amount: '1099.70' },
    });
    const rev = checkRunningBalances([...rs].reverse());
    expect(rev).toMatchObject({
      order: 'newest_first',
      breaks: [],
      openingBalance: { amount: '1000.00' },
    });
    const broken = checkRunningBalances([
      rs[0] as NormalizedRecord,
      { ...(rs[2] as NormalizedRecord), rowNumber: 9 },
    ]);
    expect(broken.breaks).toEqual([9]);
  });
  test('matchExisting: duplicate, conflict, matched, new', () => {
    const staged = [
      rec({ fingerprint: 'fp1:a', amount: '10.00' }),
      rec({ fingerprint: 'fp1:b', amount: '20.00', bankReference: 'R-1' }),
      rec({ fingerprint: 'fp1:c', amount: '30.00', postingDate: '2025-01-03' }),
      rec({ fingerprint: 'fp1:d', amount: '40.00' }),
      rec({ fingerprint: 'fp1:a', amount: '10.00' }),
    ];
    const existing = [
      {
        id: 'e1',
        postingDate: '2025-01-01',
        amount: { amount: '-10.00', currency: 'BAM' },
        fingerprint: 'fp1:a',
      },
      {
        id: 'e2',
        postingDate: '2025-01-01',
        amount: { amount: '-25.00', currency: 'BAM' },
        fingerprint: 'fp1:z',
        bankReference: 'r-1',
      },
      { id: 'e3', postingDate: '2025-01-01', amount: { amount: '-30.00', currency: 'BAM' } },
      { id: 'e4', postingDate: '2025-01-20', amount: { amount: '-40.00', currency: 'BAM' } },
    ];
    expect(matchExisting(staged, existing).map((m) => [m.outcome, m.existingId])).toEqual([
      ['duplicate', 'e1'],
      ['conflict', 'e2'],
      ['matched', 'e3'],
      ['new', undefined],
      ['duplicate', undefined],
    ]);
  });
});

describe('coverage (Feature 127)', () => {
  test('day segments and monthly roll-up', () => {
    const segs = computeCoverage(
      [
        { start: '2025-01-01', end: '2025-01-31', balance: 'balanced' },
        { start: '2025-02-01', end: '2025-02-10', balance: 'unverifiable' },
        { start: '2025-02-05', end: '2025-02-06', balance: 'mismatch' },
      ],
      '2024-12-30',
      '2025-03-31',
    );
    expect(segs).toEqual([
      { start: '2024-12-30', end: '2024-12-31', status: 'missing' },
      { start: '2025-01-01', end: '2025-01-31', status: 'complete' },
      { start: '2025-02-01', end: '2025-02-04', status: 'unverified' },
      { start: '2025-02-05', end: '2025-02-06', status: 'conflicting' },
      { start: '2025-02-07', end: '2025-02-10', status: 'unverified' },
      { start: '2025-02-11', end: '2025-03-31', status: 'missing' },
    ]);
    expect(monthlyCoverage(segs).map((m) => [m.month, m.status])).toEqual([
      ['2024-12', 'missing'],
      ['2025-01', 'complete'],
      ['2025-02', 'conflicting'],
      ['2025-03', 'missing'],
    ]);
    const partial = monthlyCoverage(
      computeCoverage(
        [{ start: '2025-04-01', end: '2025-04-10', balance: 'balanced' }],
        '2025-04-01',
        '2025-04-30',
      ),
    );
    expect(partial[0]?.status).toBe('partial');
  });
});

describe('registry and input', () => {
  test('rejects wrong sdk version, duplicates, blocked importers', async () => {
    const imp = (
      id: string,
      status: 'stable' | 'blocked_external' = 'stable',
      sdkVersion = IMPORTER_SDK_VERSION,
    ) => ({
      manifest: { ...manifest, id, status, sdkVersion },
      detect: async () => ({ confidence: id === 'a' ? 0.4 : 0.9 }),
      parse: async () => {
        throw new Error('n/a');
      },
    });
    const reg = new ImporterRegistry([imp('a'), imp('b'), imp('blocked', 'blocked_external')]);
    expect(() => reg.register(imp('a'))).toThrow('duplicate');
    expect(() => reg.register(imp('c', 'stable', 99))).toThrow('sdkVersion');
    expect(() => reg.require('blocked')).toThrow('not available');
    const found = await reg.detect(inputFromBytes('x.csv', enc.encode('a')));
    expect(found.map((f) => f.importer.id)).toEqual(['b', 'a']);
  });
  test('readAll enforces the byte limit', async () => {
    await expect(readAll(inputFromBytes('x', new Uint8Array(10)), { maxBytes: 5 })).rejects.toThrow(
      'limited to 5',
    );
  });
});
