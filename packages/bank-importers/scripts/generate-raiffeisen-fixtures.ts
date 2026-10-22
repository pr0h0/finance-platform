// Synthetic Raiffeisen BiH "IZVOD - OBAVIJEST" PDF that mimics the real layout (positions, labels,
// number format, wrapped descriptions, page break with repeated header, fee summary footer).
// Every name, account, IBAN (the public BA example IBAN), merchant and amount is invented.
// Run: BUN_WORKDIR=packages/bank-importers scripts/bun.sh scripts/generate-raiffeisen-fixtures.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..', '..', 'test-fixtures', 'imports', 'raiffeisen-bih');
const H = 842; // A4 height; positions below are top-down like the parser sees them

type Text = [x: number, y: number, size: number, s: string];
const pages: Text[][] = [[], []];
const t = (p: number, x: number, y: number, s: string, size = 7) =>
  (pages[p] as Text[]).push([x, y, size, s]);

// Amounts in minor units; printed as 1,234.56.
const fmt = (c: bigint) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const int = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${int}.${(a % 100n).toString().padStart(2, '0')}`;
};

const opening = 125000n;
const rows: {
  p: number;
  d: [string, string];
  desc: string[];
  cur: string;
  orig: bigint;
  km: bigint;
}[] = [
  {
    p: 0,
    d: ['03/03/2025', '01/03/2025'],
    desc: ['PEKARA ZITO 12'],
    cur: 'BAM',
    orig: 0n,
    km: -450n,
  },
  {
    p: 0,
    d: ['03/03/2025', '02/03/2025'],
    desc: ['Online Shop Example'],
    cur: 'BAM',
    orig: 0n,
    km: -12n,
  },
  {
    p: 0,
    d: ['03/03/2025', '02/03/2025'],
    desc: ['Online Shop Example'],
    cur: 'EUR',
    orig: -1500n,
    km: -2934n,
  },
  {
    p: 0,
    d: ['05/03/2025', '05/03/2025'],
    desc: ['PLATA PRIMJER FIRMA D.O.O.', 'SARAJEVO'],
    cur: 'BAM',
    orig: 0n,
    km: 234567n,
  },
  {
    p: 0,
    d: ['06/03/2025', '06/03/2025'],
    desc: ['PRENOS SA IVANA TESTIC NA', 'MARKO TESTIC', 'STEDNI RACUN'],
    cur: 'BAM',
    orig: 0n,
    km: -350000n,
  },
  {
    p: 0,
    d: ['07/03/2025', '06/03/2025'],
    desc: ['SOPING CENTAR'],
    cur: 'BAM',
    orig: 0n,
    km: -7520n,
  },
  {
    p: 1,
    d: ['10/03/2025', '08/03/2025'],
    desc: ['Video Service'],
    cur: 'USD',
    orig: -999n,
    km: -1785n,
  },
  {
    p: 1,
    d: ['12/03/2025', '12/03/2025'],
    desc: ['UPLATA IVANA TESTIC', 'GOTOVINA'],
    cur: 'BAM',
    orig: 0n,
    km: 10000n,
  },
  {
    p: 1,
    d: ['12/03/2025', '11/03/2025'],
    desc: ['PEKARA ZITO 12'],
    cur: 'BAM',
    orig: 0n,
    km: -450n,
  },
  {
    p: 1,
    d: ['12/03/2025', '11/03/2025'],
    desc: ['PEKARA ZITO 12'],
    cur: 'BAM',
    orig: 0n,
    km: -450n,
  },
  {
    p: 1,
    d: ['31/03/2025', '31/03/2025'],
    desc: ['Nak za odrz kartice'],
    cur: 'BAM',
    orig: 0n,
    km: -150n,
  },
];
const closing = rows.reduce((s, r) => s + r.km, opening);

// Page 1 header block.
t(0, 23, 82, 'IVANA TESTIC', 10);
t(0, 23, 104, 'ULICA PRIMJER 1', 10);
t(0, 23, 121, '71000 SARAJEVO', 10);
t(0, 23, 137, 'BOSNA I HERCEGOVINA', 10);
t(0, 274, 80, 'Podaci o racunu', 8);
t(0, 274, 99, 'Racun:');
t(0, 274, 110, '0700000000001');
t(0, 274, 128, 'IBAN:');
t(0, 274, 138, 'BA391290079401028494');
t(0, 274, 156, 'Proizvod:');
t(0, 274, 167, 'Tekuci Racun');
t(0, 426, 77, 'Pregled stanja racuna', 8);
for (const [x, a, b, v] of [
  [426, 'Pocetno', 'stanje:', opening],
  [473, 'Odobreni', 'limit:', 0n],
  [528, 'Konacno', 'stanje:', closing],
] as const) {
  t(0, x, 104, a);
  t(0, x, 115, b);
  t(0, x, 127, fmt(v));
}
t(0, 245, 209, 'IZVOD - OBAVIJEST', 9);
t(0, 203, 222, 'period od: 01/03/2025 do: 31/03/2025', 9);

const header = (p: number, y: number) => {
  t(p, 22, y + 9, 'Datum obrade');
  t(p, 92, y + 4.5, 'Datum');
  t(p, 92, y + 13.5, 'transakcije');
  t(p, 161, y + 9, 'Opis transakcije');
  t(p, 343, y + 4.5, 'Valuta');
  t(p, 324, y + 13.5, 'transakcije');
  for (const [x, cur] of [
    [386, 'valuti'],
    [455, 'KM'],
  ] as const) {
    t(p, x + 29, y, 'Iznos');
    t(p, x, y + 9, 'transakcije u');
    t(p, x + 29, y + 18, cur);
  }
  t(p, 553, y + 9, 'Saldo');
};
header(0, 254);
header(1, 28.5);

let bal = opening;
const ys = [283, 63];
for (const r of rows) {
  const n = r.desc.length;
  const y = (ys[r.p] as number) + (n - 1) * 4.85; // wrapped lines are centred on the amounts row
  bal += r.km;
  t(r.p, 22, y, r.d[0]);
  t(r.p, 91, y, r.d[1]);
  r.desc.forEach((s, i) => {
    t(r.p, 160, y + (i - (n - 1) / 2) * 9.7, s);
  });
  t(r.p, 351, y, r.cur);
  t(r.p, 418, y, fmt(r.orig));
  t(r.p, 480, y, fmt(r.km));
  t(r.p, 545, y, fmt(bal));
  ys[r.p] = y + (n - 1) * 4.85 + 11.25 + (n > 1 ? 4 : 0);
}
const end = ys[1] as number;
t(1, 0, end + 10, '...', 10);
t(1, 15, end + 36, 'Pregled ukupnog iznosa neplacenih naknada i kamata:', 8);
t(1, 22, end + 52, 'Naziv naknade');
t(1, 359, end + 52, 'Datum naknade');
t(1, 520, end + 52, 'Iznos naknade u KM');
t(1, 22, end + 64, 'Mjesecna naknada za karticu');
t(1, 359, end + 64, '31/03/2025');
t(1, 555, end + 64, '-1.50');
t(1, 32, end + 100, 'Odobreni limit:');
t(1, 262, end + 100, '0.00');
t(1, 314, end + 100, 'Konacno stanje:');
t(1, 544, end + 100, fmt(closing));
t(1, 32, end + 112, 'Raspoloživo stanje:');
t(1, 544, end + 112, fmt(closing));
t(1, 20, end + 140, 'Info', 9);
t(1, 22, end + 158, '-');
t(
  1,
  40,
  end + 158,
  'Hvala sto koristite karticu Raiffeisen BANK d.d. Bosna i Hercegovina (sinteticki primjer)',
);

// WinAnsiEncoding bytes (covers Š š Ž ž); escape PDF string delimiters.
const winAnsi = new Map<string, number>();
const dec = new TextDecoder('windows-1252');
for (let b = 0; b < 256; b++) winAnsi.set(dec.decode(new Uint8Array([b])), b);
const pdfString = (s: string) =>
  [...s]
    .map((ch) => {
      const b = winAnsi.get(ch);
      if (b === undefined) throw new Error(`${ch} not in WinAnsi`);
      const c = String.fromCharCode(b);
      return c === '(' || c === ')' || c === '\\' ? `\\${c}` : c;
    })
    .join('');

const objs: string[] = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
];
for (const [i, texts] of pages.entries()) {
  const content = texts
    .map(([x, y, size, s]) => `BT /F1 ${size} Tf ${x} ${H - y} Td (${pdfString(s)}) Tj ET`)
    .join('\n');
  objs.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 ${H}] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  );
}
objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
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
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'izvod-synthetic.pdf'), pdf, 'latin1');
console.log('written', join(dir, 'izvod-synthetic.pdf'), 'closing', fmt(closing));
