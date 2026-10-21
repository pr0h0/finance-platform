// Declarative tabular templates (CSV/TSV/XLSX/XLS/PDF-table). Data only: no code, no regex, no
// expressions. Every string is matched literally; unknown keys are rejected. Reference: docs/importing/templates.md
import { z } from 'zod';
import type { ResultBuilder } from './records.ts';
import type { ImportIssue } from './types.ts';
import { DATE_FORMAT_RE, isKnownCurrency, parseAmount, parseDate } from './values.ts';

export const TEMPLATE_SCHEMA_VERSION = 1;
export const MAX_TEMPLATE_BYTES = 32 * 1024;

const text = (max = 200) => z.string().max(max);
const columnRef = z.union([text(100).min(1), z.number().int().min(0).max(500)]);

export const templateSchema = z
  .object({
    schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'lowercase slug'),
    name: text().min(1),
    templateVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, 'semver x.y.z')
      .default('1.0.0'),
    bank: z
      .object({
        name: text().min(1),
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
        bic: z
          .string()
          .regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/)
          .optional(),
      })
      .strict()
      .optional(),
    /** xlsx also reads legacy .xls; pdf means a text PDF laid out as a table. */
    format: z.enum(['csv', 'tsv', 'xlsx', 'pdf']),
    encoding: z
      .enum(['auto', 'utf-8', 'utf-16le', 'utf-16be', 'windows-1250', 'iso-8859-2'])
      .default('auto'),
    delimiter: z.enum(['auto', ';', ',', '\t', '|']).default('auto'),
    quote: z.enum(['"', "'", '']).default('"'),
    sheet: z.union([text(100), z.number().int().min(0).max(100)]).optional(),
    skipRows: z.number().int().min(0).max(1000).default(0),
    header: z.boolean().default(true),
    columns: z
      .object({
        postingDate: columnRef,
        valueDate: columnRef.optional(),
        description: z.union([columnRef, z.array(columnRef).min(1).max(5)]),
        amount: columnRef.optional(),
        debit: columnRef.optional(),
        credit: columnRef.optional(),
        direction: columnRef.optional(),
        currency: columnRef.optional(),
        reference: columnRef.optional(),
        runningBalance: columnRef.optional(),
        counterparty: columnRef.optional(),
        accountRef: columnRef.optional(),
        originalAmount: columnRef.optional(),
        originalCurrency: columnRef.optional(),
      })
      .strict(),
    dateFormat: z
      .string()
      .max(20)
      .regex(DATE_FORMAT_RE, 'tokens YYYY YY MM M DD D and . / - space'),
    valueDateFormat: z.string().max(20).regex(DATE_FORMAT_RE).optional(),
    number: z
      .object({
        decimalSeparator: z.enum(['.', ',']),
        thousandsSeparator: z.enum(['', '.', ',', ' ', "'"]).default(''),
      })
      .strict()
      .refine((n) => n.decimalSeparator !== n.thousandsSeparator, 'separators must differ'),
    amountSign: z.enum(['negative_is_debit', 'positive_is_debit']).default('negative_is_debit'),
    directionValues: z
      .object({ debit: z.array(text(40)).min(1).max(10), credit: z.array(text(40)).min(1).max(10) })
      .strict()
      .optional(),
    currency: z
      .string()
      .refine((c) => isKnownCurrency(c), 'unknown currency')
      .optional(),
    /** Rows whose date does not parse (footers, sub-totals) are skipped with a warning instead of failing. */
    skipInvalidRows: z.boolean().default(true),
    detect: z
      .object({
        headerIncludes: z.array(text(100)).max(20).optional(),
        fileNameIncludes: z.array(text(60)).max(10).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const c = t.columns;
    if (c.amount === undefined && c.debit === undefined && c.credit === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['columns', 'amount'],
        message: 'map amount or debit/credit',
      });
    if (c.amount !== undefined && (c.debit !== undefined || c.credit !== undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['columns', 'amount'],
        message: 'use amount OR debit/credit',
      });
    if (c.direction !== undefined && !t.directionValues)
      ctx.addIssue({
        code: 'custom',
        path: ['directionValues'],
        message: 'required with a direction column',
      });
    if (!t.header) {
      for (const [k, v] of Object.entries(c))
        for (const ref of Array.isArray(v) ? v : [v])
          if (typeof ref === 'string')
            ctx.addIssue({
              code: 'custom',
              path: ['columns', k],
              message: 'header:false needs column indexes',
            });
    }
  });

export type ImportTemplate = z.output<typeof templateSchema>;
export type ImportTemplateInput = z.input<typeof templateSchema>;

export type TemplateValidation =
  | { ok: true; template: ImportTemplate }
  | { ok: false; issues: { path: string; message: string }[] };

/** Validate untrusted template JSON (object or string). Never evaluates anything. */
export function validateTemplate(input: unknown): TemplateValidation {
  let value = input;
  if (typeof input === 'string') {
    if (input.length > MAX_TEMPLATE_BYTES)
      return { ok: false, issues: [{ path: '', message: 'template too large' }] };
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, issues: [{ path: '', message: 'invalid JSON' }] };
    }
  } else if (JSON.stringify(input ?? null).length > MAX_TEMPLATE_BYTES) {
    return { ok: false, issues: [{ path: '', message: 'template too large' }] };
  }
  const r = templateSchema.safeParse(value);
  if (r.success) return { ok: true, template: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

export interface TableRow {
  /** 1-based source position (line or sheet row). */
  line: number;
  cells: string[];
}

const norm = (s: string) => s.replace(/^﻿/, '').trim().toLowerCase();

/** Whether a header row contains every `detect.headerIncludes` label (case-insensitive, literal). */
export function headerMatches(t: ImportTemplate, header: string[]): boolean {
  const want = t.detect?.headerIncludes ?? [];
  if (want.length === 0) return false;
  const have = new Set(header.map(norm));
  return want.every((w) => have.has(norm(w)));
}

/** Map table rows through a template into the builder. Returns false on a fatal mapping error. */
export async function applyTemplate(
  t: ImportTemplate,
  rows: AsyncIterable<TableRow>,
  out: ResultBuilder,
  fallbackCurrency?: string,
): Promise<boolean> {
  let names: string[] | undefined;
  let index: Map<string, number> | undefined;
  let skipped = 0;
  const resolve = (ref: string | number): number | undefined =>
    typeof ref === 'number' ? ref : index?.get(norm(ref));
  type Cols = Record<keyof ImportTemplate['columns'], number[] | undefined>;
  let cols: Cols | undefined;
  const debitSet = new Set((t.directionValues?.debit ?? []).map(norm));
  const creditSet = new Set((t.directionValues?.credit ?? []).map(norm));

  for await (const row of rows) {
    if (skipped < t.skipRows) {
      skipped++;
      continue;
    }
    if (row.cells.every((c) => c.trim() === '')) continue;
    if (!cols) {
      if (t.header) {
        names = row.cells.map((c) => c.replace(/^﻿/, '').trim());
        index = new Map(names.map((n, i) => [norm(n), i]));
      }
      const built: Partial<Cols> = {};
      const missing: string[] = [];
      for (const [k, v] of Object.entries(t.columns)) {
        if (v === undefined) continue;
        const refs = Array.isArray(v) ? v : [v];
        const idx = refs.map(resolve);
        if (idx.some((i) => i === undefined)) missing.push(`${k}=${refs.join('|')}`);
        built[k as keyof Cols] = idx as number[];
      }
      if (missing.length > 0) {
        out.errors.push({
          code: 'missing_column',
          message: `columns not found: ${missing.join(', ')}`,
        });
        return false;
      }
      cols = built as Cols;
      if (t.header) continue;
    }
    const cell = (k: keyof Cols): string | undefined => {
      const idx = cols?.[k];
      if (!idx) return undefined;
      return idx
        .map((i) => row.cells[i] ?? '')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .join(' ');
    };
    const raw: Record<string, string> = {};
    row.cells.forEach((c, i) => {
      raw[names?.[i] || `col_${i}`] = c;
    });
    const issue = (code: string, field: string, message: string): ImportIssue => ({
      row: row.line,
      field,
      code,
      message,
    });

    const dateText = cell('postingDate') ?? '';
    const postingDate = parseDate(dateText, t.dateFormat);
    if (!postingDate) {
      const i = issue(
        'invalid_date',
        'postingDate',
        `cannot read date "${dateText}" as ${t.dateFormat}`,
      );
      (t.skipInvalidRows ? out.warnings : out.errors).push(i);
      continue;
    }
    const vd = cell('valueDate');
    const valueDate = vd ? parseDate(vd, t.valueDateFormat ?? t.dateFormat) : undefined;
    const warnings: ImportIssue[] = [];
    if (vd && !valueDate)
      warnings.push(issue('invalid_value_date', 'valueDate', `ignored "${vd}"`));

    const amt = (k: keyof Cols): string | undefined | null => {
      const v = cell(k);
      if (v === undefined || v === '') return undefined;
      return parseAmount(v, t.number) ?? null; // null = present but unreadable
    };
    let signedAmount: string | undefined;
    if (cols.amount) {
      const a = amt('amount');
      if (a == null) {
        out.errors.push(
          issue('invalid_amount', 'amount', `cannot read amount "${cell('amount') ?? ''}"`),
        );
        continue;
      }
      if (cols.direction) {
        const dv = norm(cell('direction') ?? '');
        const mag = a.replace(/^-/, '');
        if (debitSet.has(dv)) signedAmount = `-${mag}`;
        else if (creditSet.has(dv)) signedAmount = mag;
        else {
          out.errors.push(issue('invalid_direction', 'direction', `unknown direction "${dv}"`));
          continue;
        }
      } else {
        const flip = t.amountSign === 'positive_is_debit';
        signedAmount = flip ? (a.startsWith('-') ? a.slice(1) : `-${a}`) : a;
      }
    } else {
      const d = amt('debit');
      const c = amt('credit');
      if (d === null || c === null) {
        out.errors.push(issue('invalid_amount', 'amount', 'cannot read debit/credit amount'));
        continue;
      }
      const dz = d === undefined || !/[1-9]/.test(d);
      const cz = c === undefined || !/[1-9]/.test(c);
      if (!dz && !cz) {
        out.errors.push(issue('ambiguous_amount', 'amount', 'both debit and credit are filled'));
        continue;
      }
      if (dz && cz) {
        out.warnings.push(issue('zero_amount', 'amount', 'no debit or credit amount; row skipped'));
        continue;
      }
      signedAmount = dz ? (c as string).replace(/^-/, '') : `-${(d as string).replace(/^-/, '')}`;
    }
    let runningBalance: string | undefined;
    if (cols.runningBalance) {
      const rb = amt('runningBalance');
      if (rb === null)
        warnings.push(issue('invalid_balance', 'runningBalance', 'ignored unreadable balance'));
      else runningBalance = rb;
    }
    const oa = cols.originalAmount ? amt('originalAmount') : undefined;
    out.add({
      rowNumber: row.line,
      postingDate,
      valueDate,
      signedAmount,
      currency: cell('currency') || t.currency || fallbackCurrency || '',
      description: cell('description') ?? '',
      bankReference: cell('reference'),
      counterparty: cell('counterparty'),
      accountRef: cell('accountRef'),
      runningBalance,
      originalAmount: oa ?? undefined,
      originalCurrency: cell('originalCurrency'),
      raw,
      confidence: warnings.length > 0 ? 0.9 : 1,
      warnings,
    });
  }
  if (!cols) out.errors.push({ code: 'empty_file', message: 'no rows found' });
  return cols !== undefined;
}
