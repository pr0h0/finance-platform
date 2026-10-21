// Regenerate the Go↔TS parser conformance goldens (run from the repo root):
//   scripts/bun.sh run apps/api/internal/imports/testdata/golden/generate.ts
// Each golden is what the TS importer (packages/bank-importers) produces for a shared fixture in
// packages/test-fixtures/imports; internal/imports/golden_test.go checks the Go parsers agree.
import { readFileSync, writeFileSync } from 'node:fs';
import { importers } from '../../../../../../packages/bank-importers/src/index.ts';
import { inputFromBytes } from '../../../../../../packages/importer-sdk/src/index.ts';

const F = 'packages/test-fixtures/imports/';
const OUT = 'apps/api/internal/imports/testdata/golden/';
const cases: { name: string; file: string; importer: string; template?: string; currency?: string }[] = [
  { name: 'csv-signed', file: 'csv/signed-utf8.csv', importer: 'generic-csv', template: 'signed-amount-csv.json' },
  { name: 'csv-overlap', file: 'csv/signed-overlap.csv', importer: 'generic-csv', template: 'signed-amount-csv.json' },
  { name: 'csv-errors', file: 'csv/errors.csv', importer: 'generic-csv', template: 'signed-amount-csv.json' },
  { name: 'csv-primjer-utf8', file: 'csv/primjer-banka-utf8.csv', importer: 'generic-csv', template: 'primjer-banka-csv.json' },
  { name: 'csv-primjer-1250', file: 'csv/primjer-banka-1250.csv', importer: 'generic-csv', template: 'primjer-banka-csv.json' },
  { name: 'csv-primjer-8859-2', file: 'csv/primjer-banka-8859-2.csv', importer: 'generic-csv', template: 'primjer-banka-csv.json' },
  { name: 'tsv-direction', file: 'tsv/direction.tsv', importer: 'generic-tsv', template: 'direction-tsv.json' },
  { name: 'ofx-v1', file: 'ofx/statement-v1.ofx', importer: 'generic-ofx' },
  { name: 'ofx-v2', file: 'ofx/statement-v2.ofx', importer: 'generic-ofx' },
  { name: 'qfx', file: 'ofx/statement.qfx', importer: 'generic-qfx' },
  { name: 'qif-us', file: 'qif/us.qif', importer: 'generic-qif', currency: 'USD' },
  { name: 'qif-eu', file: 'qif/eu.qif', importer: 'generic-qif', currency: 'EUR' },
  { name: 'camt053', file: 'camt/camt053.xml', importer: 'generic-camt053' },
  { name: 'camt054', file: 'camt/camt054.xml', importer: 'generic-camt054' },
  { name: 'mt940', file: 'mt940/statement.sta', importer: 'generic-mt940' },
  { name: 'json', file: 'json/finplat.json', importer: 'generic-json' },
];
for (const c of cases) {
  const imp = importers.find((i) => i.manifest.id === c.importer);
  if (!imp) throw new Error(`no importer ${c.importer}`);
  const bytes = new Uint8Array(readFileSync(F + c.file));
  const template = c.template ? JSON.parse(readFileSync(`${F}templates/${c.template}`, 'utf8')) : undefined;
  let result: unknown;
  try {
    result = await imp.parse(inputFromBytes(c.file.split('/').pop() ?? c.file, bytes), { accountCurrency: c.currency, template });
  } catch (e) {
    result = { fatal: String((e as Error).message) };
  }
  writeFileSync(`${OUT}${c.name}.json`, `${JSON.stringify({ case: c, result }, null, 1)}\n`);
}
