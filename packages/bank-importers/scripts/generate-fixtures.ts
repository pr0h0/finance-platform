// Regenerates the binary / non-UTF-8 synthetic fixtures in packages/test-fixtures/imports.
// Run: BUN_WORKDIR=packages/bank-importers scripts/bun.sh scripts/generate-fixtures.ts
// All data is invented ("Primjer Banka" does not exist).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';

const dir = join(import.meta.dir, '..', '..', 'test-fixtures', 'imports');

// --- single-byte Central European CSVs (Windows-1250 and ISO-8859-2) ---
const csvText = [
  'Primjer Banka d.d. - izvod po računu',
  'Račun: 000-SYNTH-001;;;;;;',
  'Datum;Datum valute;Opis;Primalac;Duguje;Potražuje;Stanje;Referenca',
  '02.01.2025;02.01.2025;Kupovina;Trgovina Šećer;45,20;;1.954,80;R-001',
  '03.01.2025;03.01.2025;Uplata plate;Poslodavac d.o.o.;;2.500,00;4.454,80;R-002',
  '05.01.2025;04.01.2025;"Račun; struja";Elektroprivreda ŽĐ;120,00;;4.334,80;R-003',
  '07.01.2025;07.01.2025;Ćevapi i čaj;Ćevabdžinica Željo;15,50;;4.319,30;',
  'Ukupno;;;;180,70;2.500,00;;',
].join('\r\n');

// Windows-1250 and ISO-8859-2 differ in exactly the letters we need (š ž Š Ž ...).
function encodeSingleByte(text: string, label: string): Uint8Array {
  const dec = new TextDecoder(label);
  const table = new Map<string, number>();
  for (let b = 0; b < 256; b++) {
    const ch = dec.decode(new Uint8Array([b]));
    if (!table.has(ch)) table.set(ch, b);
  }
  return Uint8Array.from(
    [...text].map((ch) => {
      const b = table.get(ch);
      if (b === undefined) throw new Error(`${ch} not in ${label}`);
      return b;
    }),
  );
}
writeFileSync(
  join(dir, 'csv', 'primjer-banka-1250.csv'),
  encodeSingleByte(csvText, 'windows-1250'),
);
writeFileSync(
  join(dir, 'csv', 'primjer-banka-8859-2.csv'),
  encodeSingleByte(csvText, 'iso-8859-2'),
);
writeFileSync(join(dir, 'csv', 'primjer-banka-utf8.csv'), csvText);

// --- XLSX / XLS with real date and number cells ---
const ws = XLSX.utils.aoa_to_sheet(
  [
    ['Synthetic export - not a real bank'],
    ['Datum', 'Opis', 'Iznos', 'Valuta', 'Stanje'],
    [new Date(Date.UTC(2025, 0, 2)), 'Kupovina', -45.2, 'BAM', 954.8],
    [new Date(Date.UTC(2025, 0, 3)), 'Uplata', 2500, 'BAM', 3454.8],
    ['04.01.2025', 'Datum kao tekst', '-12,00', 'BAM', 3442.8],
    [new Date(Date.UTC(2025, 0, 5)), 'Float noise', 0.1 + 0.2, 'BAM', 3443.1],
    ['Ukupno', '', 2442.7, '', ''],
  ],
  { cellDates: true, dateNF: 'yyyy-mm-dd' },
);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['cover sheet']]), 'Info');
XLSX.utils.book_append_sheet(wb, ws, 'Transakcije');
writeFileSync(
  join(dir, 'xlsx', 'statement.xlsx'),
  XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
);
writeFileSync(
  join(dir, 'xlsx', 'statement.xls'),
  XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }),
);

// --- text PDF laid out as a table ---
const rows = [
  ['Date', 'Description', 'Amount', 'Balance'],
  ['01.02.2025', 'Opening card fee', '-2,00', '998,00'],
  ['03.02.2025', 'Salary February', '1.500,00', '2.498,00'],
  ['04.02.2025', 'Grocery store 12', '-63,45', '2.434,55'],
  ['Page total', '', '1.434,55', ''],
];
const xs = [50, 140, 330, 430];
let content = 'BT /F1 14 Tf 50 790 Td (Synthetic Bank - Statement February 2025) Tj ET\n';
rows.forEach((r, i) => {
  r.forEach((cell, j) => {
    if (cell) content += `BT /F1 10 Tf ${xs[j]} ${740 - i * 18} Td (${cell}) Tj ET\n`;
  });
});
const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
];
let pdf = '%PDF-1.4\n';
const offsets: number[] = [];
objs.forEach((o, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(dir, 'pdf', 'statement.pdf'), pdf, 'latin1');
console.log('fixtures written to', dir);
