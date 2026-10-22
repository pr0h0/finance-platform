import { describe, expect, test } from 'bun:test';
import {
  type BankImporter,
  checkRunningBalances,
  checkStatementBalance,
  coverageSources,
  type ImportContext,
  type ImportResult,
  inputFromBytes,
  matchExisting,
  merchantMatcher,
} from '@finplat/importer-sdk';
import { importFixture } from '@finplat/test-fixtures';
import {
  camtImporter,
  createRegistry,
  delimitedImporter,
  excelNumberText,
  itemsToRows,
  jsonImporter,
  MarkupStream,
  mt940Importer,
  ofxImporter,
  parseMarkup,
  pdfTextImporter,
  qifImporter,
  raiffeisenBih,
  readTablePreview,
  spreadsheetImporter,
  suggestTemplate,
} from './index.ts';

const tpl = (name: string): unknown =>
  JSON.parse(new TextDecoder().decode(importFixture(`templates/${name}.json`)));
const file = (path: string) => inputFromBytes(path.split('/').pop() as string, importFixture(path));
const parse = (imp: BankImporter, path: string, ctx: ImportContext = {}) =>
  imp.parse(file(path), ctx);
const brief = (r: ImportResult) =>
  r.records.map((x) => [x.postingDate, x.direction, x.amount, x.currency]);

describe('registry', () => {
  test('detects each fixture with the right importer first', async () => {
    const reg = createRegistry();
    const cases: [string, string][] = [
      ['ofx/statement-v1.ofx', 'generic-ofx'],
      ['ofx/statement.qfx', 'generic-qfx'],
      ['qif/us.qif', 'generic-qif'],
      ['camt/camt053.xml', 'generic-camt053'],
      ['camt/camt054.xml', 'generic-camt054'],
      ['mt940/statement.sta', 'generic-mt940'],
      ['json/finplat.json', 'generic-json'],
      ['csv/signed-utf8.csv', 'generic-csv'],
      ['tsv/direction.tsv', 'generic-tsv'],
      ['xlsx/statement.xlsx', 'generic-xlsx'],
      ['xlsx/statement.xls', 'generic-xls'],
      ['pdf/statement.pdf', 'generic-pdf-text'],
    ];
    for (const [path, id] of cases) {
      const found = await reg.detect(file(path));
      expect([path, found[0]?.importer.id]).toEqual([path, id]);
    }
  });
});

describe('Raiffeisen BiH PDF (synthetic layout fixture)', () => {
  const pdf = 'raiffeisen-bih/izvod-synthetic.pdf';
  test('registry ranks the bank importer above the generic PDF one; others are not claimed', async () => {
    const found = await createRegistry().detect(file(pdf));
    expect(found.map((c) => c.importer.id).slice(0, 2)).toEqual([
      'raiffeisen-bih',
      'generic-pdf-text',
    ]);
    expect((await raiffeisenBih.detect(file('pdf/statement.pdf'))).confidence).toBe(0);
    expect((await raiffeisenBih.detect(file('csv/signed-utf8.csv'))).confidence).toBe(0);
    await expect(parse(raiffeisenBih, 'pdf/statement.pdf')).rejects.toThrow('not a Raiffeisen');
  });
  test('header, rows, wrapped descriptions, foreign amounts and reconciliation', async () => {
    const r = await parse(raiffeisenBih, pdf);
    expect(r.errors).toEqual([]);
    expect(r.statements).toEqual([
      {
        ref: '0700000000001:2025-03-01..2025-03-31',
        accountRef: 'BA391290079401028494',
        periodStart: '2025-03-01',
        periodEnd: '2025-03-31',
        openingBalance: '1250.00',
        closingBalance: '58.16',
        currency: 'BAM',
      },
    ]);
    expect(brief(r)).toEqual([
      ['2025-03-03', 'debit', '4.50', 'BAM'],
      ['2025-03-03', 'debit', '0.12', 'BAM'],
      ['2025-03-03', 'debit', '29.34', 'BAM'],
      ['2025-03-05', 'credit', '2345.67', 'BAM'],
      ['2025-03-06', 'debit', '3500.00', 'BAM'],
      ['2025-03-07', 'debit', '75.20', 'BAM'],
      ['2025-03-10', 'debit', '17.85', 'BAM'],
      ['2025-03-12', 'credit', '100.00', 'BAM'],
      ['2025-03-12', 'debit', '4.50', 'BAM'],
      ['2025-03-12', 'debit', '4.50', 'BAM'],
      ['2025-03-31', 'debit', '1.50', 'BAM'],
    ]);
    const [, , eur, salary, transfer, shop, usd] = r.records;
    expect(salary?.description).toBe('PLATA PRIMJER FIRMA D.O.O. SARAJEVO');
    expect(transfer?.description).toBe('PRENOS SA IVANA TESTIC NA MARKO TESTIC STEDNI RACUN');
    expect(transfer?.runningBalance).toBe('61.71');
    expect(shop?.description).toBe('SOPING CENTAR'); // the bank prints ASCII only
    // A merchant saved in normal Bosnian spelling still matches the ASCII description.
    const match = merchantMatcher(
      [{ id: 'm1', normalizedName: 'Šoping Centar', defaultCategoryId: null }],
      [],
    );
    expect(match(shop?.description ?? '')?.merchantId).toBe('m1');
    expect(r.records[0]?.valueDate).toBe('2025-03-01');
    expect([eur?.originalAmount, eur?.originalCurrency]).toEqual(['15.00', 'EUR']);
    expect([usd?.originalAmount, usd?.originalCurrency]).toEqual(['9.99', 'USD']);
    expect(r.records[1]?.originalCurrency).toBeUndefined();
    expect(checkStatementBalance(r.statements[0] as never, r.records).status).toBe('balanced');
    expect(checkRunningBalances(r.records).breaks).toEqual([]);
    expect(coverageSources(r)).toEqual([
      { start: '2025-03-01', end: '2025-03-31', balance: 'balanced', label: r.statements[0]?.ref },
    ]);
    // Two identical bakery rows on the same day stay two records (occurrence ordinal).
    expect(r.records[8]?.fingerprint).not.toBe(r.records[9]?.fingerprint);
    // A tampered closing balance is reported as a mismatch, not silently accepted.
    const st = { ...(r.statements[0] as object), closingBalance: '58.17' };
    expect(checkStatementBalance(st, r.records).status).toBe('mismatch');
  });
});

describe('CSV / TSV templates', () => {
  const csv = delimitedImporter('csv');
  test('template required and validated', async () => {
    await expect(parse(csv, 'csv/signed-utf8.csv')).rejects.toThrow('mapping template');
    await expect(
      parse(csv, 'csv/signed-utf8.csv', { template: { schemaVersion: 1 } }),
    ).rejects.toThrow('invalid');
  });
  test('UTF-8 BOM, quoted fields, signed amounts, thousands separators, currency column', async () => {
    const r = await parse(csv, 'csv/signed-utf8.csv', { template: tpl('signed-amount-csv') });
    expect(r.encoding).toBe('utf-8');
    expect(r.errors).toEqual([]);
    expect(brief(r)).toEqual([
      ['2025-01-03', 'debit', '3.50', 'EUR'],
      ['2025-01-03', 'debit', '3.50', 'EUR'],
      ['2025-01-05', 'credit', '2500.00', 'EUR'],
      ['2025-01-07', 'debit', '45.10', 'EUR'],
      ['2025-01-09', 'debit', '600.00', 'EUR'],
      ['2025-01-10', 'debit', '100.00', 'BAM'],
    ]);
    expect(r.records[0]?.description).toBe('Coffee Shop "Bean"');
    expect(r.records[4]?.description).toBe('Rent payment Jan');
    expect(r.records[0]?.fingerprint).not.toBe(r.records[1]?.fingerprint);
  });
  test('same statement in Windows-1250, ISO-8859-2 and UTF-8 parses identically', async () => {
    const results = await Promise.all(
      ['1250', '8859-2', 'utf8'].map((e) =>
        parse(csv, `csv/primjer-banka-${e}.csv`, { template: tpl('primjer-banka-csv') }),
      ),
    );
    expect(results.map((r) => r.encoding)).toEqual(['windows-1250', 'iso-8859-2', 'utf-8']);
    const [a, b, c] = results as [ImportResult, ImportResult, ImportResult];
    expect(a.records.map((x) => x.fingerprint)).toEqual(c.records.map((x) => x.fingerprint));
    expect(b.records.map((x) => x.fingerprint)).toEqual(c.records.map((x) => x.fingerprint));
    expect(a.records.map((x) => x.counterparty)).toEqual([
      'Trgovina Šećer',
      'Poslodavac d.o.o.',
      'Elektroprivreda ŽĐ',
      'Ćevabdžinica Željo',
    ]);
    expect(a.records[2]?.description).toBe('Račun; struja Elektroprivreda ŽĐ');
    expect(a.records[2]?.valueDate).toBe('2025-01-04');
    expect(brief(a)).toEqual([
      ['2025-01-02', 'debit', '45.20', 'BAM'],
      ['2025-01-03', 'credit', '2500.00', 'BAM'],
      ['2025-01-05', 'debit', '120.00', 'BAM'],
      ['2025-01-07', 'debit', '15.50', 'BAM'],
    ]);
    expect(a.records[1]?.runningBalance).toBe('4454.80');
    expect(a.warnings.map((w) => w.code)).toEqual(['invalid_date']); // "Ukupno" footer
  });
  test('error file: every bad row reported, good row kept', async () => {
    const r = await parse(csv, 'csv/errors.csv', {
      template: { ...(tpl('signed-amount-csv') as object), skipInvalidRows: false },
    });
    expect(r.errors.map((e) => [e.row, e.code])).toEqual([
      [2, 'invalid_date'],
      [3, 'invalid_amount'],
      [4, 'unknown_currency'],
      [5, 'amount_precision'],
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(['zero_amount']);
    expect(brief(r)).toEqual([['2025-01-06', 'debit', '7.25', 'EUR']]);
    expect(r.confidence).toBeLessThan(0.5);
  });
  test('overlapping statements dedupe by fingerprint', async () => {
    const t = { template: tpl('signed-amount-csv') };
    const first = await parse(csv, 'csv/signed-utf8.csv', t);
    const second = await parse(csv, 'csv/signed-overlap.csv', t);
    const existing = first.records.map((r, i) => ({
      id: `e${i}`,
      postingDate: r.postingDate,
      amount: { amount: r.direction === 'debit' ? `-${r.amount}` : r.amount, currency: r.currency },
      fingerprint: r.fingerprint,
    }));
    expect(matchExisting(second.records, existing).map((m) => m.outcome)).toEqual([
      'duplicate', // grocery TX-1007
      'duplicate', // rent TX-1009
      'duplicate', // transfer TX-1010
      'new', // pharmacy
      'new', // coffee on another day
    ]);
  });
  test('TSV with direction column', async () => {
    const r = await parse(delimitedImporter('tsv'), 'tsv/direction.tsv', {
      template: tpl('direction-tsv'),
    });
    expect(brief(r)).toEqual([
      ['2025-01-02', 'debit', '60.00', 'USD'],
      ['2025-01-03', 'credit', '15.25', 'USD'],
      ['2025-01-04', 'debit', '1020.40', 'USD'],
    ]);
    expect(r.errors.map((e) => e.code)).toEqual(['invalid_direction']);
  });
  test('mapping editor helpers', async () => {
    const p = await readTablePreview(file('csv/primjer-banka-1250.csv'), { format: 'csv' }, 4);
    expect(p.delimiter).toBe(';');
    expect(p.encoding).toBe('windows-1250');
    expect(p.rows[2]?.[5]).toBe('Potražuje');
    const s = suggestTemplate(p.rows[2] as string[], [p.rows[3] as string[]]);
    expect(s).toEqual({
      columns: {
        postingDate: 'Datum',
        valueDate: 'Datum valute',
        description: 'Opis',
        debit: 'Duguje',
        credit: 'Potražuje',
        reference: 'Referenca',
        runningBalance: 'Stanje',
        counterparty: 'Primalac',
      },
      dateFormat: 'DD.MM.YYYY',
      number: { decimalSeparator: ',', thousandsSeparator: '.' },
    });
  });
});

describe('spreadsheets', () => {
  test('excel numbers are rendered with 15 significant digits', () => {
    expect(excelNumberText(0.1 + 0.2)).toBe('0.3');
    expect(excelNumberText(-45.2)).toBe('-45.2');
    expect(excelNumberText(1e-7)).toBe('0.0000001');
  });
  for (const [format, path] of [
    ['xlsx', 'xlsx/statement.xlsx'],
    ['xls', 'xlsx/statement.xls'],
  ] as const) {
    test(`${format}: date cells, text dates, numeric cells, named sheet`, async () => {
      const r = await parse(spreadsheetImporter(format), path, { template: tpl('sheet-xlsx') });
      expect(r.errors).toEqual([]);
      expect(brief(r)).toEqual([
        ['2025-01-02', 'debit', '45.20', 'BAM'],
        ['2025-01-03', 'credit', '2500.00', 'BAM'],
        ['2025-01-04', 'debit', '12.00', 'BAM'],
        ['2025-01-05', 'credit', '0.30', 'BAM'],
      ]);
      expect(r.records[0]?.runningBalance).toBe('954.80');
      expect(r.warnings.map((w) => w.code)).toEqual(['invalid_date']); // "Ukupno"
    });
  }
  test('preview lists sheets', async () => {
    const p = await readTablePreview(
      file('xlsx/statement.xlsx'),
      { format: 'xlsx', sheet: 'Transakcije' },
      3,
    );
    expect(p.sheets).toEqual(['Info', 'Transakcije']);
    expect(p.rows[2]?.[0]).toBe('2025-01-02');
  });
});

describe('OFX / QFX', () => {
  test('OFX 1.x SGML with entities and foreign currency', async () => {
    const r = await parse(ofxImporter(false), 'ofx/statement-v1.ofx');
    expect(r.errors).toEqual([]);
    expect(brief(r)).toEqual([
      ['2025-01-03', 'debit', '3.50', 'EUR'],
      ['2025-01-05', 'credit', '2500.00', 'EUR'],
      ['2025-01-10', 'debit', '46.00', 'EUR'],
    ]);
    expect(r.records[0]).toMatchObject({
      description: 'Coffee Shop & Co Card 1234',
      bankReference: 'OFX-0001',
      accountRef: 'SYNTH-0001',
    });
    expect(r.records[2]).toMatchObject({
      originalAmount: '50.00',
      originalCurrency: 'USD',
      exchangeRate: '0.92',
    });
    expect(r.statements[0]).toMatchObject({
      periodStart: '2025-01-01',
      periodEnd: '2025-01-31',
      closingBalance: '2442.50',
    });
  });
  test('OFX 2.x XML credit card with ORIGCURRENCY', async () => {
    const r = await parse(ofxImporter(false), 'ofx/statement-v2.ofx');
    expect(brief(r)).toEqual([
      ['2025-02-03', 'debit', '120.40', 'BAM'],
      ['2025-02-20', 'credit', '120.40', 'BAM'],
    ]);
    expect(r.records[0]).toMatchObject({
      description: 'Supermarket Šipad',
      originalAmount: '61.56',
      originalCurrency: 'EUR',
    });
  });
  test('QFX and same-content OFX produce identical fingerprints', async () => {
    const a = await parse(ofxImporter(true), 'ofx/statement.qfx');
    const b = await parse(ofxImporter(false), 'ofx/statement-v1.ofx');
    expect(a.format).toBe('qfx');
    expect(a.records.map((x) => x.fingerprint)).toEqual(b.records.map((x) => x.fingerprint));
  });
  test('rejects non-OFX', async () => {
    await expect(parse(ofxImporter(false), 'qif/us.qif')).rejects.toThrow('no <OFX>');
  });
});

describe('QIF', () => {
  test('US dates with apostrophe years, grouping commas, splits kept raw', async () => {
    const r = await parse(qifImporter(), 'qif/us.qif', { accountCurrency: 'USD' });
    expect(brief(r)).toEqual([
      ['2025-01-03', 'debit', '3.50', 'USD'],
      ['2025-01-15', 'credit', '2500.00', 'USD'],
      ['2025-01-20', 'debit', '1234.56', 'USD'],
    ]);
    expect(r.records[2]?.warnings.map((w) => w.code)).toEqual(['qif_splits_ignored']);
    expect(r.records[2]?.raw.splits).toContain('SHousing');
    expect(r.warnings).toEqual([]);
  });
  test('European dates and decimal comma', async () => {
    const r = await parse(qifImporter(), 'qif/eu.qif', { accountCurrency: 'BAM' });
    expect(brief(r)).toEqual([
      ['2025-01-03', 'debit', '3.50', 'BAM'],
      ['2025-01-05', 'credit', '1250.00', 'BAM'],
    ]);
    expect(r.records[0]?.description).toBe('Kafić');
  });
  test('ambiguous day/month order is flagged', async () => {
    const r = await parse(qifImporter(), 'qif/ambiguous.qif', { accountCurrency: 'EUR' });
    expect(r.warnings.map((w) => w.code)).toEqual(['ambiguous_date_order']);
    expect(r.records.map((x) => x.postingDate)).toEqual(['2025-01-02', '2025-03-04']);
    expect(r.confidence).toBe(0.7);
  });
  test('no currency → errors, not guesses', async () => {
    const r = await parse(qifImporter(), 'qif/eu.qif');
    expect(r.records).toEqual([]);
    expect(r.errors.map((e) => e.code)).toEqual(['missing_currency', 'missing_currency']);
  });
});

describe('CAMT', () => {
  test('CAMT.053: balances reconcile, pending skipped, FX details, batched entry', async () => {
    const r = await parse(camtImporter('053'), 'camt/camt053.xml');
    expect(r.errors).toEqual([]);
    expect(brief(r)).toEqual([
      ['2025-01-05', 'credit', '2000.00', 'BAM'],
      ['2025-01-10', 'debit', '150.00', 'BAM'],
      ['2025-01-20', 'debit', '44.90', 'BAM'],
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(['not_booked']);
    expect(r.records[0]).toMatchObject({
      counterparty: 'Employer d.o.o.',
      bankReference: 'REF-0001',
      accountRef: 'BA391234567890123456',
    });
    expect(r.records[1]).toMatchObject({
      valueDate: '2025-01-09',
      originalAmount: '76.69',
      originalCurrency: 'EUR',
      exchangeRate: '1.95583',
      description: 'Supermarket & Co Kupovina',
    });
    expect(r.records[2]?.description).toBe('Struja Voda');
    expect(r.records[2]?.warnings.map((w) => w.code)).toEqual(['batched_entry']);
    const st = r.statements[0];
    expect(st).toMatchObject({
      ref: 'STMT-2025-01',
      periodStart: '2025-01-01',
      periodEnd: '2025-01-31',
      openingBalance: '1000.00',
      closingBalance: '2805.10',
    });
    expect(checkStatementBalance(st as never, r.records).status).toBe('balanced');
    expect(coverageSources(r)).toEqual([
      { start: '2025-01-01', end: '2025-01-31', balance: 'balanced', label: 'STMT-2025-01' },
    ]);
  });
  test('CAMT.054 reversal flips direction', async () => {
    const r = await parse(camtImporter('054'), 'camt/camt054.xml', { accountCurrency: 'EUR' });
    expect(brief(r)).toEqual([['2025-03-01', 'credit', '12.00', 'EUR']]);
    expect(r.records[0]?.accountRef).toBe('SYNTH-ACC-7');
  });
  test('XML safety: DTD rejected, mismatched tags rejected', () => {
    expect(() =>
      parseMarkup('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'),
    ).toThrow('DOCTYPE');
    expect(() => parseMarkup('<a><b></a>')).toThrow();
    expect(parseMarkup('<a>&#x160;&lt;<![CDATA[<raw>]]></a>').children[0]?.text).toBe('Š<<raw>');
  });
});

describe('MT940', () => {
  test('two statements, envelope, multi-line :86:, year crossover, reversal', async () => {
    const r = await parse(mt940Importer(), 'mt940/statement.sta');
    expect(r.errors).toEqual([]);
    expect(brief(r)).toEqual([
      ['2024-12-31', 'debit', '25.50', 'BAM'],
      ['2025-01-02', 'credit', '500.00', 'BAM'],
      ['2025-01-03', 'debit', '10.00', 'BAM'],
      ['2025-01-04', 'credit', '5.00', 'BAM'],
    ]);
    expect(r.records[0]).toMatchObject({
      description: 'Kartično plaćanje Market 12 Sarajevo',
      bankReference: 'BANKREF-1',
      statementRef: 'STMT-001',
    });
    expect(r.records[2]?.bankReference).toBe('NONREF');
    expect(r.records[3]?.warnings.map((w) => w.code)).toEqual(['reversal']);
    expect(
      r.statements.map((s) => [
        s.ref,
        s.openingBalance,
        s.closingBalance,
        s.periodStart,
        s.periodEnd,
      ]),
    ).toEqual([
      ['STMT-001', '1000.00', '1464.50', '2024-12-30', '2025-01-03'],
      ['STMT-002', '1464.50', '1469.50', '2025-01-03', '2025-01-04'],
    ]);
    for (const s of r.statements)
      expect(
        checkStatementBalance(
          s,
          r.records.filter((x) => x.statementRef === s.ref),
        ).status,
      ).toBe('balanced');
  });
});

describe('JSON', () => {
  test('finplat-import: string amounts only, scale per currency', async () => {
    const r = await parse(jsonImporter(), 'json/finplat.json');
    expect(brief(r)).toEqual([
      ['2025-04-02', 'debit', '20.00', 'EUR'],
      ['2025-04-03', 'credit', '0.01', 'EUR'],
      ['2025-04-05', 'credit', '1000', 'JPY'],
    ]);
    expect(r.errors.map((e) => [e.row, e.code])).toEqual([[3, 'invalid_amount']]);
    const st = r.statements[0];
    expect(
      checkStatementBalance(
        st as never,
        r.records.filter((x) => x.statementRef === 'J-1'),
      ).status,
    ).toBe('balanced');
  });
  test('rejects other shapes', async () => {
    const bad = inputFromBytes('x.json', new TextEncoder().encode('{"format":"other"}'));
    await expect(jsonImporter().parse(bad, {})).rejects.toThrow('finplat-import');
  });
});

describe('streaming XML (CAMT / OFX)', () => {
  // Same file delivered in tiny chunks: tokens, entities and multi-byte characters split anywhere.
  const chunked = (path: string, size: number) => {
    const bytes = importFixture(path);
    return {
      fileName: path.split('/').pop() as string,
      size: bytes.length,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
            c.close();
          },
        }),
    };
  };
  test('chunk boundaries do not change the result', async () => {
    const cases: [BankImporter, string, ImportContext][] = [
      [camtImporter('053'), 'camt/camt053.xml', {}],
      [camtImporter('054'), 'camt/camt054.xml', {}],
      [ofxImporter(false), 'ofx/statement-v1.ofx', {}],
      [ofxImporter(false), 'ofx/statement-v2.ofx', {}],
      [ofxImporter(true), 'ofx/statement.qfx', {}],
    ];
    for (const [imp, path, ctx] of cases) {
      const whole = await parse(imp, path, ctx);
      expect(whole.records.length).toBeGreaterThan(0);
      for (const size of [1, 7, 64])
        expect(await imp.parse(chunked(path, size), ctx)).toEqual(whole);
    }
  });
  test('entries are dropped from the tree once handled', () => {
    let seen = 0;
    const p = new MarkupStream({
      onClose: (n) => n.name === 'Ntry' && ++seen > 0,
    });
    for (const c of [
      '<Doc><Stmt><Id>S1</Id>',
      '<Ntry><Amt>1</Am',
      't></Ntry><Ntry/>',
      '</Stmt></Doc>',
    ])
      p.write(c);
    const root = p.end();
    expect(seen).toBe(2);
    expect(root.children[0]?.children[0]?.children.map((c) => c.name)).toEqual(['Id']);
    expect(() => new MarkupStream().end()).not.toThrow();
    expect(() => new MarkupStream().write('<a><!DOCTYPE x [')).toThrow('DOCTYPE');
    const cut = new MarkupStream();
    cut.write('<a><!DOC'); // too short to classify yet: buffered, rejected at the end
    expect(() => cut.end()).toThrow('DOCTYPE');
  });
});

describe('PDF', () => {
  test('text PDF table through a template', async () => {
    const r = await parse(pdfTextImporter(), 'pdf/statement.pdf', { template: tpl('pdf-table') });
    expect(r.errors).toEqual([]);
    expect(brief(r)).toEqual([
      ['2025-02-01', 'debit', '2.00', 'EUR'],
      ['2025-02-03', 'credit', '1500.00', 'EUR'],
      ['2025-02-04', 'debit', '63.45', 'EUR'],
    ]);
    expect(r.records[2]?.description).toBe('Grocery store 12');
    expect(r.records[2]?.runningBalance).toBe('2434.55');
    expect(r.records.every((x) => x.confidence <= 0.9)).toBe(true);
  });
  test('itemsToRows groups by baseline and gap', () => {
    const rows = itemsToRows([
      { str: '01.02.2025', x: 50, y: 100, w: 40, h: 10, page: 1 },
      { str: 'Two', x: 140, y: 101, w: 15, h: 10, page: 1 },
      { str: 'words', x: 157, y: 100, w: 25, h: 10, page: 1 },
      { str: '-2,00', x: 330, y: 100, w: 20, h: 10, page: 1 },
      { str: 'next', x: 50, y: 120, w: 20, h: 10, page: 1 },
    ]);
    expect(rows.map((r) => r.cells)).toEqual([['01.02.2025', 'Two words', '-2,00'], ['next']]);
  });
});
