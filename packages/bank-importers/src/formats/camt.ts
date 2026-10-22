// ISO 20022 CAMT.053 (account statement) and CAMT.054 (debit/credit notification), any version.
import {
  type BankImporter,
  DEFAULT_MAX_BYTES,
  decodeStream,
  ImportError,
  type ImportIssue,
  ResultBuilder,
} from '@finplat/importer-sdk';
import { children, find, MarkupStream, type Node, textAt } from './markup.ts';
import { compactDate, headText, manifest } from './util.ts';

const OPENING = new Set(['OPBD', 'PRCD']);
const CLOSING = new Set(['CLBD']);

function balance(
  stmt: Node,
  codes: Set<string>,
): { amount: string; currency?: string } | undefined {
  for (const b of children(stmt, 'Bal')) {
    const code = textAt(b, 'Tp/CdOrPrtry/Cd');
    if (!code || !codes.has(code)) continue;
    const amt = find(b, 'Amt');
    const v = amt?.text.trim();
    if (!v) continue;
    const neg = textAt(b, 'CdtDbtInd') === 'DBIT';
    return { amount: neg && /[1-9]/.test(v) ? `-${v}` : v, currency: amt?.attrs.Ccy };
  }
  return undefined;
}

const dateOf = (n: Node | undefined, path: string) =>
  compactDate(textAt(n, `${path}/Dt`) ?? textAt(n, `${path}/DtTm`));

export function camtImporter(kind: '053' | '054'): BankImporter {
  const format = kind === '053' ? 'camt053' : 'camt054';
  const container = kind === '053' ? 'BkToCstmrStmt' : 'BkToCstmrDbtCdtNtfctn';
  const item = kind === '053' ? 'Stmt' : 'Ntfctn';
  const m = manifest({
    id: `generic-camt${kind}`,
    version: '1.0.0',
    name: `ISO 20022 CAMT.${kind}`,
    formats: [format],
    status: 'stable',
    limitations: [
      'Batched entries (several TxDtls under one Ntry) become one record for the entry amount; the details are kept in raw.',
      'Pending (PDNG) and informational entries are skipped with a warning.',
    ],
  });
  return {
    manifest: m,
    async detect(input) {
      const head = await headText(input, 4096);
      if (new RegExp(`camt\\.0${kind.slice(1)}\\.`).test(head) || head.includes(`<${container}>`))
        return { confidence: 0.98, format, reason: `camt.${kind} namespace` };
      return { confidence: 0 };
    },
    async parse(input, ctx) {
      const out = new ResultBuilder(m, format, ctx);
      const max = ctx.maxBytes ?? DEFAULT_MAX_BYTES;
      if (input.size > max)
        throw new ImportError('file_too_large', `file is ${input.size} bytes; limit ${max}`);
      // Streamed: each Ntry is turned into a record when it closes and then dropped, so memory holds
      // one entry plus the statement headers (Id and Acct precede Ntry in every CAMT version).
      let row = 0;
      const stmtCtx = (s: Node) => ({
        ref: textAt(s, 'Id'),
        acct: textAt(s, 'Acct/Id/IBAN') ?? textAt(s, 'Acct/Id/Othr/Id'),
        ccy: textAt(s, 'Acct/Ccy') ?? ctx.accountCurrency,
      });
      const parser = new MarkupStream({
        onClose(n, up) {
          const s = up[up.length - 1];
          if (n.name !== 'Ntry' || s?.name !== item || up[up.length - 2]?.name !== container)
            return false;
          row++;
          addEntry(out, n, row, stmtCtx(s));
          return true;
        },
      });
      for await (const chunk of decodeStream(input, ctx)) parser.write(chunk);
      const body = find(find(parser.end(), 'Document'), container);
      if (!body) throw new ImportError('invalid_camt', `missing Document/${container}`);
      for (const s of children(body, item)) {
        const { ref, acct } = stmtCtx(s);
        const acctCcy = textAt(s, 'Acct/Ccy');
        const open = balance(s, OPENING);
        const close = balance(s, CLOSING);
        out.statements.push({
          ref,
          accountRef: acct,
          currency: acctCcy ?? open?.currency ?? close?.currency,
          periodStart: compactDate(textAt(s, 'FrToDt/FrDtTm') ?? textAt(s, 'FrToDt/FrDt')),
          periodEnd: compactDate(textAt(s, 'FrToDt/ToDtTm') ?? textAt(s, 'FrToDt/ToDt')),
          ...(open ? { openingBalance: open.amount } : {}),
          ...(close ? { closingBalance: close.amount } : {}),
        });
      }
      return out.finish();
    },
  };
}

function flatten(n: Node, prefix: string, out: Record<string, string>): void {
  for (const c of n.children) {
    const key = prefix ? `${prefix}/${c.name}` : c.name;
    const t = c.text.trim();
    if (t && c.children.length === 0)
      out[key in out ? `${key}#${Object.keys(out).length}` : key] = t;
    for (const [a, v] of Object.entries(c.attrs)) out[`${key}@${a}`] = v;
    flatten(c, key, out);
  }
}

function addEntry(
  out: ResultBuilder,
  e: Node,
  row: number,
  st: { ref?: string; acct?: string; ccy?: string },
): void {
  const raw: Record<string, string> = {};
  flatten(e, '', raw);
  const status = textAt(e, 'Sts') ?? textAt(e, 'Sts/Cd');
  if (status && status !== 'BOOK') {
    out.warnings.push({ row, code: 'not_booked', message: `entry status ${status} skipped` });
    return;
  }
  const amt = find(e, 'Amt');
  const ind = textAt(e, 'CdtDbtInd');
  const date = dateOf(e, 'BookgDt') ?? dateOf(e, 'ValDt');
  if (!amt?.text.trim() || !date || (ind !== 'CRDT' && ind !== 'DBIT')) {
    out.errors.push({
      row,
      code: 'invalid_entry',
      message: 'Ntry without Amt, CdtDbtInd or BookgDt',
    });
    return;
  }
  const warnings: ImportIssue[] = [];
  // A reversal flips the meaning of the indicator.
  let debit = ind === 'DBIT';
  if (textAt(e, 'RvslInd') === 'true') {
    debit = !debit;
    warnings.push({ row, code: 'reversal', message: 'reversal entry' });
  }
  const txs = children(find(e, 'NtryDtls'), 'TxDtls');
  const tx = txs[0];
  if (txs.length > 1)
    warnings.push({
      row,
      code: 'batched_entry',
      message: `${txs.length} transactions in one entry`,
    });
  const party = debit ? 'Cdtr' : 'Dbtr';
  const counterparty =
    textAt(tx, `RltdPties/${party}/Nm`) ?? textAt(tx, `RltdPties/${party}/Pty/Nm`);
  const ustrd = txs.flatMap((t) => children(find(t, 'RmtInf'), 'Ustrd').map((u) => u.text.trim()));
  const description = [counterparty, ...ustrd, textAt(e, 'AddtlNtryInf')].filter(Boolean).join(' ');
  const instd = find(tx, 'AmtDtls/InstdAmt/Amt');
  const rate =
    textAt(tx, 'AmtDtls/InstdAmt/CcyXchg/XchgRate') ?? textAt(tx, 'AmtDtls/TxAmt/CcyXchg/XchgRate');
  const currency = amt.attrs.Ccy ?? st.ccy ?? '';
  const foreign = instd && instd.attrs.Ccy !== currency ? instd : undefined;
  out.add({
    rowNumber: row,
    postingDate: date,
    valueDate: dateOf(e, 'ValDt'),
    amount: amt.text.trim(),
    direction: debit ? 'debit' : 'credit',
    currency,
    description,
    counterparty,
    bankReference:
      textAt(e, 'AcctSvcrRef') ?? textAt(tx, 'Refs/AcctSvcrRef') ?? textAt(tx, 'Refs/EndToEndId'),
    accountRef: st.acct,
    statementRef: st.ref,
    originalAmount: foreign?.text.trim(),
    originalCurrency: foreign?.attrs.Ccy,
    exchangeRate: foreign ? rate : undefined,
    raw,
    warnings,
    confidence: warnings.some((w) => w.code === 'batched_entry') ? 0.9 : 1,
  });
}
