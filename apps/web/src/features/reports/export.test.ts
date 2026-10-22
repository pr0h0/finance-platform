import { expect, test } from 'bun:test';
import * as XLSX from 'xlsx';
import { csvBlob, csvCell, toCsv } from './export.ts';

test('csv quoting and formula-injection guard', () => {
  expect(csvCell('a,b')).toBe('"a,b"');
  expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
  expect(csvCell('@cmd')).toBe("'@cmd");
  expect(csvCell('-12.50')).toBe('-12.50');
  expect(csvCell(null)).toBe('');
  expect(
    toCsv([
      ['a', 1],
      ['b', '2'],
    ]),
  ).toBe('a,1\r\nb,2\r\n');
});

const bosnian = 'Štednja čćđšž ČĆĐŠŽ — 1.234,56 KM €';

test('csv is UTF-8 with an optional BOM for Excel', async () => {
  const bytes = new Uint8Array(await csvBlob([[bosnian]]).arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(new TextDecoder().decode(bytes.slice(3))).toBe(`"${bosnian}"\r\n`);
  const plain = new Uint8Array(await csvBlob([[bosnian]], false).arrayBuffer());
  expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(plain).charCodeAt(0)).toBe(0x22);
});

test('xlsx keeps Bosnian characters and decimal strings', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[bosnian, '-1234.56']]), 'Izvještaj');
  const back = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
  expect(back.SheetNames).toEqual(['Izvještaj']);
  const rows = XLSX.utils.sheet_to_json<string[]>(back.Sheets['Izvještaj'] as XLSX.WorkSheet, {
    header: 1,
  });
  expect(rows).toEqual([[bosnian, '-1234.56']]);
});
