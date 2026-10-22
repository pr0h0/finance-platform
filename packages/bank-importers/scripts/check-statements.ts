// Run the bank importers over local statements and print only aggregates (no descriptions, no
// amounts of single rows): balance check, difference, parse errors, running-balance breaks.
// Raiffeisen BiH only for now. Usage: scripts/bun.sh packages/bank-importers/scripts/check-statements.ts samples/*.pdf
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { checkRunningBalances, checkStatementBalance, inputFromBytes } from '@finplat/importer-sdk';
import { raiffeisenBih } from '../src/index.ts';

for (const path of process.argv.slice(2)) {
  const input = inputFromBytes(basename(path), new Uint8Array(readFileSync(path)));
  try {
    const r = await raiffeisenBih.parse(input, {});
    for (const s of r.statements) {
      const rs = r.records.filter((x) => !s.ref || x.statementRef === s.ref);
      const c = checkStatementBalance(s, rs);
      const run = checkRunningBalances(rs);
      console.log(
        [
          basename(path),
          `${s.periodStart}..${s.periodEnd}`,
          `rows=${rs.length}`,
          c.status === 'mismatch' ? `MISMATCH off by ${c.difference.amount}` : c.status,
          `errors=${r.errors.length}${r.errors.length ? ` (rows ${r.errors.map((e) => e.row).join(',')})` : ''}`,
          `runningBreaks=${run.breaks.length}${run.breaks.length ? ` (rows ${run.breaks.slice(0, 10).join(',')})` : ''}`,
        ].join('  '),
      );
    }
  } catch (e) {
    console.log(`${basename(path)}: ${(e as Error).message}`);
  }
}
