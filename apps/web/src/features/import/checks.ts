import { checkStatementBalance, type ImportResult } from '@finplat/importer-sdk';

export type BalanceStatus = 'balanced' | 'mismatch' | 'unverifiable';

/** One status for a parsed file: any statement mismatch wins, all balanced = balanced. */
export function balanceStatus(r: ImportResult): BalanceStatus {
  const checks = r.statements.map(
    (s) =>
      checkStatementBalance(
        s,
        r.records.filter((x) => !s.ref || x.statementRef === s.ref),
      ).status,
  );
  if (checks.includes('mismatch')) return 'mismatch';
  if (checks.length && checks.every((c) => c === 'balanced')) return 'balanced';
  return 'unverifiable';
}
