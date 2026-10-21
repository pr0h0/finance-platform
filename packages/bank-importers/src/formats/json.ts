// finplat JSON interchange: {"format":"finplat-import","version":1,"statements":[…],"transactions":[…]}
// or a bare array of transactions. Amounts are decimal strings (numbers are rejected: no floats).
import {
  type BankImporter,
  decodeBytes,
  ImportError,
  ResultBuilder,
  readAll,
  type StatementInfo,
} from '@finplat/importer-sdk';
import { ext, headText, manifest } from './util.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function jsonImporter(): BankImporter {
  const m = manifest({
    id: 'generic-json',
    version: '1.0.0',
    name: 'JSON (finplat interchange)',
    formats: ['json'],
    status: 'stable',
    limitations: [
      'Only the documented finplat-import shape is accepted (docs/importing/formats.md).',
    ],
  });
  return {
    manifest: m,
    async detect(input) {
      const head = (await headText(input, 2048)).trimStart();
      if (/"format"\s*:\s*"finplat-import"/.test(head)) return { confidence: 0.98, format: 'json' };
      if (ext(input) === 'json' && /^[[{]/.test(head)) return { confidence: 0.4, format: 'json' };
      return { confidence: 0 };
    },
    async parse(input, ctx) {
      const out = new ResultBuilder(m, 'json', ctx);
      let doc: unknown;
      try {
        doc = JSON.parse(decodeBytes(await readAll(input, ctx), ctx.encoding ?? 'auto'));
      } catch {
        throw new ImportError('invalid_json', 'file is not valid JSON');
      }
      let txs: unknown = doc;
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
        const d = doc as Record<string, unknown>;
        if (d.format !== 'finplat-import' || d.version !== 1)
          throw new ImportError('invalid_json', 'expected format "finplat-import" version 1');
        txs = d.transactions;
        for (const s of Array.isArray(d.statements) ? d.statements : []) {
          const o = (s ?? {}) as Record<string, unknown>;
          const st: StatementInfo = {};
          for (const k of [
            'ref',
            'accountRef',
            'periodStart',
            'periodEnd',
            'openingBalance',
            'closingBalance',
            'currency',
          ] as const) {
            const v = str(o[k]);
            if (v) st[k] = v;
          }
          out.statements.push(st);
        }
      }
      if (!Array.isArray(txs))
        throw new ImportError('invalid_json', 'transactions must be an array');
      txs.forEach((t, i) => {
        const row = i + 1;
        if (!t || typeof t !== 'object') {
          out.errors.push({ row, code: 'invalid_record', message: 'not an object' });
          return;
        }
        const o = t as Record<string, unknown>;
        const date = str(o.postingDate);
        const amount = str(o.amount);
        if (typeof o.amount === 'number') {
          out.errors.push({
            row,
            field: 'amount',
            code: 'invalid_amount',
            message: 'amount must be a decimal string, not a number',
          });
          return;
        }
        if (
          !date ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !amount ||
          !/^-?\d+(\.\d+)?$/.test(amount)
        ) {
          out.errors.push({
            row,
            code: 'invalid_record',
            message: 'postingDate (YYYY-MM-DD) and amount (signed decimal string) are required',
          });
          return;
        }
        const raw: Record<string, string> = {};
        for (const [k, v] of Object.entries(o))
          if (v != null) raw[k] = typeof v === 'string' ? v : JSON.stringify(v);
        out.add({
          rowNumber: row,
          postingDate: date,
          valueDate: str(o.valueDate),
          signedAmount: amount,
          currency: str(o.currency) ?? ctx.accountCurrency ?? '',
          description: str(o.description) ?? '',
          bankReference: str(o.reference),
          counterparty: str(o.counterparty),
          accountRef: str(o.accountRef),
          statementRef: str(o.statementRef),
          runningBalance: str(o.runningBalance),
          originalAmount: str(o.originalAmount),
          originalCurrency: str(o.originalCurrency),
          exchangeRate: str(o.exchangeRate),
          raw,
        });
      });
      return out.finish();
    },
  };
}
