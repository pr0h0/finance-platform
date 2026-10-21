// Quicken Interchange Format (bank, cash, credit-card accounts). Streamed line by line.
import {
  type BankImporter,
  decodeStream,
  type ImportIssue,
  isoDate,
  lines,
  parseAmount,
  ResultBuilder,
  type TextEncodingName,
} from '@finplat/importer-sdk';
import { ext, headText, manifest } from './util.ts';

const SUPPORTED_TYPES = new Set(['bank', 'cash', 'ccard', 'oth a', 'oth l']);

/** QIF amounts use whatever the exporting locale used; the last of ',' / '.' is the decimal mark. */
export function qifAmount(s: string): string | undefined {
  const v = s.trim();
  const lastComma = v.lastIndexOf(',');
  const lastDot = v.lastIndexOf('.');
  let dec: '.' | ',' = '.';
  if (lastComma > lastDot) {
    // "1,234" (3 digits after the only comma) is a thousands group, "12,50" a decimal comma.
    const after = v.length - lastComma - 1;
    if (lastDot >= 0) dec = ',';
    else dec = v.indexOf(',') !== lastComma || after === 3 ? '.' : ',';
  }
  return parseAmount(v, { decimalSeparator: dec, thousandsSeparator: dec === ',' ? '.' : ',' });
}

interface Pending {
  line: number;
  f: Record<string, string>;
  splits: string[];
}

/** Split a QIF date into [a, b, year] — "1/15'25", "15.01.2025", "2025-01-15". */
function dateParts(s: string): [number, number, number] | undefined {
  const t = s.trim().replace(/\s/g, '');
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) return [Number(iso[2]), Number(iso[3]), Number(iso[1])]; // month, day (unambiguous)
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-]|')\s*(\d{2}|\d{4})$/.exec(t);
  if (!m) return undefined;
  let y = Number(m[3]);
  if (y < 100) y += y < 70 ? 2000 : 1900;
  return [Number(m[1]), Number(m[2]), y];
}

export function qifImporter(): BankImporter {
  const m = manifest({
    id: 'generic-qif',
    version: '1.0.0',
    name: 'QIF (Quicken Interchange Format)',
    formats: ['qif'],
    status: 'stable',
    limitations: [
      'QIF has no currency: the account currency must be supplied.',
      'Day/month order is inferred from the whole file; when every date is ambiguous MM/DD is assumed (DD.MM for dot-separated dates) and a warning is raised.',
      'Split lines (S/E/$) are preserved in raw only; investment (!Type:Invst) records are skipped.',
    ],
  });
  return {
    manifest: m,
    async detect(input) {
      const head = await headText(input, 1024);
      if (/^!Type:/im.test(head) || /^!Account/im.test(head))
        return { confidence: 0.95, format: 'qif', reason: '!Type header' };
      if (ext(input) === 'qif') return { confidence: 0.5, format: 'qif' };
      return { confidence: 0 };
    },
    async parse(input, ctx) {
      const out = new ResultBuilder(m, 'qif', ctx);
      const enc: { encoding?: TextEncodingName } = {};
      const items: Pending[] = [];
      let type = 'bank';
      let cur: Pending | undefined;
      let n = 0;
      let skipped = 0;
      let inAccount = false;
      for await (const l of lines(decodeStream(input, ctx, enc))) {
        n++;
        const t = l.trimEnd();
        if (t === '') continue;
        if (t.startsWith('!')) {
          const h = t.toLowerCase();
          inAccount = h.startsWith('!account');
          if (h.startsWith('!type:')) type = h.slice(6).trim();
          continue;
        }
        if (t === '^') {
          if (cur && !inAccount) {
            if (SUPPORTED_TYPES.has(type)) items.push(cur);
            else skipped++;
          }
          cur = undefined;
          if (inAccount) inAccount = false;
          continue;
        }
        if (inAccount) continue;
        cur ??= { line: n, f: {}, splits: [] };
        const code = t[0] as string;
        const val = t.slice(1);
        if (code === 'S' || code === 'E' || code === '$') cur.splits.push(t);
        else cur.f[code] = code in cur.f ? `${cur.f[code]} ${val}` : val;
      }
      if (cur && Object.keys(cur.f).length > 0) items.push(cur);
      out.encoding = enc.encoding;
      if (skipped)
        out.warnings.push({
          code: 'unsupported_type',
          message: `${skipped} records of type ${type} skipped`,
        });

      // Decide day/month order over the whole file.
      const parts = items.map((i) => dateParts(i.f.D ?? ''));
      const dayFirst =
        parts.some((p) => p && p[0] > 12) ||
        (!parts.some((p) => p && p[1] > 12) && items.some((i) => /^\d{1,2}\.\d/.test(i.f.D ?? '')));
      const ambiguous =
        !parts.some((p) => p && (p[0] > 12 || p[1] > 12)) &&
        !items.some((i) => /^\d{4}-/.test(i.f.D?.trim() ?? ''));
      if (ambiguous && items.length > 0)
        out.warnings.push({
          code: 'ambiguous_date_order',
          message: `all dates fit both orders; assumed ${dayFirst ? 'DD/MM' : 'MM/DD'}`,
        });
      const currency = ctx.accountCurrency ?? '';
      items.forEach((it, i) => {
        const p = parts[i];
        const iso = /^\d{4}-/.test(it.f.D?.trim() ?? '');
        const date =
          p && (iso || !dayFirst ? isoDate(p[2], p[0], p[1]) : isoDate(p[2], p[1], p[0]));
        if (!date) {
          out.errors.push({
            row: it.line,
            field: 'D',
            code: 'invalid_date',
            message: `bad date "${it.f.D ?? ''}"`,
          });
          return;
        }
        const amount = qifAmount(it.f.T ?? it.f.U ?? '');
        if (amount === undefined) {
          out.errors.push({
            row: it.line,
            field: 'T',
            code: 'invalid_amount',
            message: `bad amount "${it.f.T ?? ''}"`,
          });
          return;
        }
        const warnings: ImportIssue[] = [];
        if (it.splits.length)
          warnings.push({
            row: it.line,
            code: 'qif_splits_ignored',
            message: 'QIF split lines kept in raw only',
          });
        const raw = { ...it.f, ...(it.splits.length ? { splits: it.splits.join('\n') } : {}) };
        out.add({
          rowNumber: it.line,
          postingDate: date,
          signedAmount: amount,
          currency,
          description: [it.f.P, it.f.M].filter(Boolean).join(' '),
          counterparty: it.f.P,
          bankReference: it.f.N,
          raw,
          warnings,
          confidence: ambiguous ? 0.7 : 1,
        });
      });
      return out.finish();
    },
  };
}
