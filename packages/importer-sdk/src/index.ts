// Importer plugin SDK contract (PLAN §24). Parsers are pure: bytes in, normalized records out.
import type { Decimal, ImportFormat } from '@finplat/domain';

export const IMPORTER_SDK_VERSION = 1;

export interface ImporterManifest {
  id: string; // 'generic-csv', 'raiffeisen-bih-csv'
  version: string; // semver of the parser; stored on every raw record
  sdkVersion: number;
  name: string;
  bank?: { name: string; country?: string; bic?: string };
  formats: ImportFormat[];
  status: 'stable' | 'beta' | 'blocked_external';
  limits?: { maxBytes?: number; maxRows?: number };
}

export interface ImportInput {
  fileName: string;
  bytes: Uint8Array;
  contentType?: string;
}

export interface ImportContext {
  accountCurrency?: string;
  timezone: string;
  locale?: string;
  template?: Record<string, unknown>; // declarative template definition
}

export interface DetectionResult {
  confidence: number; // 0..1
  format?: ImportFormat;
  reason?: string;
}

export interface ImportIssue {
  row?: number;
  field?: string;
  code: string;
  message: string;
}

export interface NormalizedRecord {
  rowNumber: number;
  accountRef?: string;
  statementRef?: string;
  postingDate: string; // YYYY-MM-DD as printed by the bank, never TZ-shifted
  valueDate?: string;
  description: string;
  direction: 'debit' | 'credit';
  amount: Decimal; // positive magnitude; sign comes from direction
  currency: string;
  originalAmount?: Decimal;
  originalCurrency?: string;
  exchangeRate?: Decimal;
  runningBalance?: Decimal;
  bankReference?: string;
  counterparty?: string;
  raw: Record<string, string>;
  confidence: number; // parser confidence for this row
  warnings: ImportIssue[];
}

export interface ImportResult {
  records: NormalizedRecord[];
  statement?: {
    ref?: string;
    periodStart?: string;
    periodEnd?: string;
    openingBalance?: Decimal;
    closingBalance?: Decimal;
    currency?: string;
  };
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

export interface BankImporter {
  manifest: ImporterManifest;
  detect(input: ImportInput): Promise<DetectionResult>;
  parse(input: ImportInput, context: ImportContext): Promise<ImportResult>;
}
