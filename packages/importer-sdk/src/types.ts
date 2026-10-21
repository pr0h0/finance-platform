// Importer plugin SDK contract (PLAN §24). Parsers are pure: bytes in, normalized records out.
// No network, no filesystem, no eval; templates are data only (see template.ts).
import type { Decimal } from '@finplat/domain';

export const IMPORTER_SDK_VERSION = 1;

/** Every format the framework knows. Template rows in the DB use the narrower domain ImportFormat. */
export const SOURCE_FORMATS = [
  'csv',
  'tsv',
  'xlsx',
  'xls',
  'ofx',
  'qfx',
  'qif',
  'camt053',
  'camt054',
  'mt940',
  'json',
  'pdf',
  'pdf_ocr',
] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

export interface ImporterManifest {
  id: string; // 'generic-csv', 'raiffeisen-bih'
  version: string; // semver of the parser; stored on every raw record
  sdkVersion: number;
  name: string;
  bank?: { name: string; country?: string; bic?: string };
  formats: SourceFormat[];
  status: 'stable' | 'beta' | 'blocked_external';
  /** True when the importer needs an ImportContext.template to parse. */
  requiresTemplate?: boolean;
  limits?: { maxBytes?: number; maxRows?: number };
  /** Human notes about what is and is not supported. */
  limitations?: string[];
}

/**
 * A file to import. `stream()` returns a fresh stream each call so parsers can sniff the head and
 * then stream the body without holding the whole file. Build one with inputFromBlob/inputFromBytes.
 */
export interface ImportInput {
  fileName: string;
  size: number;
  contentType?: string;
  stream(): ReadableStream<Uint8Array>;
}

export interface ImportContext {
  /** Used when the file does not carry a currency. */
  accountCurrency?: string;
  /** Explicit encoding; default 'auto' (BOM, UTF-8 validity, Windows-1250 vs ISO-8859-2 heuristic). */
  encoding?: TextEncodingName | 'auto';
  /** Declarative template (validated with validateTemplate before use). */
  template?: unknown;
  maxRows?: number;
  maxBytes?: number;
  onProgress?: (bytesRead: number) => void;
  signal?: AbortSignal;
}

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1250' | 'iso-8859-2';

export interface DetectionResult {
  confidence: number; // 0..1, 0 = not this format
  format?: SourceFormat;
  reason?: string;
}

export interface ImportIssue {
  row?: number;
  field?: string;
  code: string;
  message: string;
}

export type Direction = 'debit' | 'credit';

export interface NormalizedRecord {
  /** 1-based position in the source (line, sheet row, entry index) — the raw record reference. */
  rowNumber: number;
  accountRef?: string;
  statementRef?: string;
  postingDate: string; // YYYY-MM-DD as printed by the bank, never TZ-shifted
  valueDate?: string;
  description: string;
  direction: Direction;
  amount: Decimal; // positive magnitude at currency scale; sign comes from direction
  currency: string;
  originalAmount?: Decimal;
  originalCurrency?: string;
  exchangeRate?: Decimal;
  runningBalance?: Decimal; // signed, at currency scale
  bankReference?: string;
  counterparty?: string;
  /** Original fields exactly as read (strings), kept as immutable evidence. */
  raw: Record<string, string>;
  /** fp1 dedup fingerprint (docs/importing/fingerprint.md). Filled by finalizeResult. */
  fingerprint: string;
  confidence: number; // parser confidence for this row, 0..1
  warnings: ImportIssue[];
}

export interface StatementInfo {
  ref?: string;
  accountRef?: string;
  periodStart?: string;
  periodEnd?: string;
  openingBalance?: Decimal;
  closingBalance?: Decimal;
  currency?: string;
}

export interface ImportResult {
  importerId: string;
  importerVersion: string;
  format: SourceFormat;
  encoding?: TextEncodingName;
  records: NormalizedRecord[];
  statements: StatementInfo[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
  /** Overall confidence (minimum of row confidences, lowered by errors). */
  confidence: number;
  /** True when every value needs explicit user approval before saving (OCR). */
  requiresApproval?: boolean;
}

export interface BankImporter {
  manifest: ImporterManifest;
  detect(input: ImportInput): Promise<DetectionResult>;
  parse(input: ImportInput, context: ImportContext): Promise<ImportResult>;
}
