import { fingerprintAll } from './fingerprint.ts';
import { DEFAULT_MAX_ROWS, ImportError } from './input.ts';
import type {
  Direction,
  ImportContext,
  ImporterManifest,
  ImportIssue,
  ImportResult,
  NormalizedRecord,
  SourceFormat,
  StatementInfo,
  TextEncodingName,
} from './types.ts';
import { isKnownCurrency, normalizeCurrency, toCurrencyScale } from './values.ts';

export interface RecordDraft {
  rowNumber: number;
  postingDate: string;
  /** Either a signed amount (negative = debit) or a magnitude plus direction. */
  signedAmount?: string;
  amount?: string;
  direction?: Direction;
  currency: string;
  description: string;
  valueDate?: string;
  accountRef?: string;
  statementRef?: string;
  originalAmount?: string;
  originalCurrency?: string;
  exchangeRate?: string;
  runningBalance?: string;
  bankReference?: string;
  counterparty?: string;
  raw: Record<string, string>;
  confidence?: number;
  warnings?: ImportIssue[];
}

/**
 * Validates a parsed row and normalizes money to the currency scale. Returns an issue instead of a
 * record when the row cannot be represented exactly. Zero amounts are rejected (nothing to post).
 */
export function buildRecord(d: RecordDraft): NormalizedRecord | ImportIssue {
  const row = d.rowNumber;
  const currency = normalizeCurrency(d.currency);
  if (!currency)
    return { row, field: 'currency', code: 'missing_currency', message: 'no currency' };
  if (!isKnownCurrency(currency))
    return {
      row,
      field: 'currency',
      code: 'unknown_currency',
      message: `unknown currency ${currency}`,
    };
  let direction = d.direction;
  let mag = d.amount;
  if (d.signedAmount !== undefined) {
    direction = d.signedAmount.startsWith('-') ? 'debit' : 'credit';
    mag = d.signedAmount.replace(/^[-+]/, '');
  }
  if (mag === undefined || direction === undefined)
    return { row, field: 'amount', code: 'missing_amount', message: 'no amount' };
  mag = mag.replace(/^[-+]/, '');
  let amount: string;
  let runningBalance: string | undefined;
  let originalAmount: string | undefined;
  try {
    amount = toCurrencyScale(mag, currency);
    if (d.runningBalance !== undefined)
      runningBalance = toCurrencyScale(d.runningBalance, currency);
    if (d.originalAmount !== undefined && d.originalCurrency && isKnownCurrency(d.originalCurrency))
      originalAmount = toCurrencyScale(d.originalAmount.replace(/^[-+]/, ''), d.originalCurrency);
  } catch (e) {
    return { row, field: 'amount', code: 'amount_precision', message: (e as Error).message };
  }
  if (!/[1-9]/.test(amount))
    return { row, field: 'amount', code: 'zero_amount', message: 'zero amount row skipped' };
  const rec: NormalizedRecord = {
    rowNumber: row,
    postingDate: d.postingDate,
    description: d.description.replace(/\s+/g, ' ').trim(),
    direction,
    amount,
    currency,
    raw: d.raw,
    fingerprint: '',
    confidence: d.confidence ?? 1,
    warnings: d.warnings ?? [],
  };
  if (d.valueDate) rec.valueDate = d.valueDate;
  if (d.accountRef) rec.accountRef = d.accountRef;
  if (d.statementRef) rec.statementRef = d.statementRef;
  if (runningBalance !== undefined) rec.runningBalance = runningBalance;
  if (originalAmount !== undefined) {
    rec.originalAmount = originalAmount;
    rec.originalCurrency = d.originalCurrency;
  }
  if (d.exchangeRate) rec.exchangeRate = d.exchangeRate;
  if (d.bankReference) rec.bankReference = d.bankReference.trim();
  if (d.counterparty) rec.counterparty = d.counterparty.trim();
  return rec;
}

export function isIssue(x: NormalizedRecord | ImportIssue): x is ImportIssue {
  return 'code' in x;
}

/** Collects records/issues while a parser runs and enforces the row limit. */
export class ResultBuilder {
  readonly records: NormalizedRecord[] = [];
  readonly errors: ImportIssue[] = [];
  readonly warnings: ImportIssue[] = [];
  readonly statements: StatementInfo[] = [];
  encoding?: TextEncodingName;
  requiresApproval = false;
  private readonly maxRows: number;

  constructor(
    private readonly manifest: ImporterManifest,
    private readonly format: SourceFormat,
    ctx: ImportContext,
  ) {
    this.maxRows = ctx.maxRows ?? manifest.limits?.maxRows ?? DEFAULT_MAX_ROWS;
  }

  /** Adds a draft; zero-amount rows become warnings, other problems errors. */
  add(d: RecordDraft): void {
    const r = buildRecord(d);
    if (isIssue(r)) {
      (r.code === 'zero_amount' ? this.warnings : this.errors).push(r);
      return;
    }
    if (this.records.length >= this.maxRows)
      throw new ImportError('too_many_rows', `more than ${this.maxRows} rows`);
    this.records.push(r);
  }

  async finish(): Promise<ImportResult> {
    // Ordinals are per account (fingerprint.md); group by accountRef, keep file order.
    const groups = new Map<string, NormalizedRecord[]>();
    for (const r of this.records) {
      const k = r.accountRef ?? '';
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    for (const g of groups.values()) {
      const fps = await fingerprintAll(g);
      g.forEach((r, i) => {
        r.fingerprint = fps[i] as string;
      });
    }
    let confidence = this.records.reduce((m, r) => Math.min(m, r.confidence), 1);
    if (this.records.length === 0) confidence = 0;
    else if (this.errors.length > 0)
      confidence *= this.records.length / (this.records.length + this.errors.length);
    const result: ImportResult = {
      importerId: this.manifest.id,
      importerVersion: this.manifest.version,
      format: this.format,
      records: this.records,
      statements: this.statements,
      errors: this.errors,
      warnings: this.warnings,
      confidence: Math.round(confidence * 1000) / 1000,
    };
    if (this.encoding) result.encoding = this.encoding;
    if (this.requiresApproval) result.requiresApproval = true;
    return result;
  }
}
