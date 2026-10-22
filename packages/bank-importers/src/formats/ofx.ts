// OFX 1.x (SGML) and 2.x (XML); QFX is OFX with Intuit headers. Bank and credit-card statements.
import { convert, convertInverse } from '@finplat/finance-engine';
import {
  type BankImporter,
  DEFAULT_MAX_BYTES,
  decodeStream,
  ImportError,
  type ImportIssue,
  isKnownCurrency,
  ResultBuilder,
  toCurrencyScale,
} from '@finplat/importer-sdk';
import { find, findAll, MarkupStream, type Node, textAt } from './markup.ts';
import { compactDate, ext, headText, manifest } from './util.ts';

/** OFX amounts are signed with '.' or ',' as decimal separator and no grouping. */
export function ofxAmount(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const v = s.trim().replace(',', '.');
  return /^[+-]?\d*\.?\d+$/.test(v) ? v.replace(/^\+/, '').replace(/^(-?)\./, '$10.') : undefined;
}

export function ofxImporter(qfx: boolean): BankImporter {
  const format = qfx ? 'qfx' : 'ofx';
  const m = manifest({
    id: qfx ? 'generic-qfx' : 'generic-ofx',
    version: '1.0.0',
    name: qfx ? 'QFX (Quicken Web Connect)' : 'OFX (Open Financial Exchange)',
    formats: [format],
    status: 'stable',
    limitations: [
      'Investment statements (INVSTMTRS) are ignored.',
      'OFX carries only the closing (LEDGERBAL) balance; opening balance is derived and the statement is reported as unverifiable.',
    ],
  });
  return {
    manifest: m,
    async detect(input) {
      const head = await headText(input, 4096);
      const isOfx = /OFXHEADER:|<\?OFX|<OFX>/i.test(head);
      if (!isOfx) return { confidence: 0 };
      const e = ext(input);
      const intuit = /INTU\.BID|<INTU\./i.test(head);
      if (qfx)
        return { confidence: e === 'qfx' || intuit ? 0.95 : 0.5, format, reason: 'OFX header' };
      return { confidence: e === 'qfx' ? 0.6 : 0.95, format, reason: 'OFX header' };
    },
    async parse(input, ctx) {
      const out = new ResultBuilder(m, format, ctx);
      const max = ctx.maxBytes ?? DEFAULT_MAX_BYTES;
      if (input.size > max)
        throw new ImportError('file_too_large', `file is ${input.size} bytes; limit ${max}`);
      // OFX 1.x declares CHARSET:1252 etc.; the auto detector covers UTF-8 and CE code pages.
      const sgml = !/<\?xml/i.test((await headText(input, 200)).slice(0, 200));
      // Streamed: each STMTTRN becomes a record when it closes and is dropped; CURDEF and the
      // account precede BANKTRANLIST in STMTRS/CCSTMTRS, so the statement context is known by then.
      let row = 0;
      const acctOf = (s: Node) =>
        textAt(s, 'BANKACCTFROM/ACCTID') ?? textAt(s, 'CCACCTFROM/ACCTID');
      const curOf = (s: Node) => textAt(s, 'CURDEF') ?? ctx.accountCurrency ?? '';
      const parser = new MarkupStream({
        sgml,
        upperNames: sgml, // SGML OFX tags are case-insensitive
        onClose(n, up) {
          const s = up[up.length - 2];
          if (n.name !== 'STMTTRN' || up[up.length - 1]?.name !== 'BANKTRANLIST') return false;
          if (s?.name !== 'STMTRS' && s?.name !== 'CCSTMTRS') return false;
          row++;
          addTrn(out, n, row, curOf(s), acctOf(s));
          return true;
        },
      });
      for await (const chunk of decodeStream(input, ctx)) parser.write(chunk);
      const root = parser.end();
      if (!root.children.some((c) => c.name.toUpperCase() === 'OFX'))
        throw new ImportError('invalid_ofx', 'no <OFX> element');
      const stmts = [...findAll(root, 'STMTRS'), ...findAll(root, 'CCSTMTRS')];
      if (stmts.length === 0)
        out.errors.push({ code: 'no_statement', message: 'no bank or card statement' });
      for (const s of stmts) {
        const list = find(s, 'BANKTRANLIST');
        const closing = ofxAmount(textAt(s, 'LEDGERBAL/BALAMT'));
        out.statements.push({
          accountRef: acctOf(s),
          currency: curOf(s),
          periodStart: compactDate(textAt(list, 'DTSTART')),
          periodEnd: compactDate(textAt(list, 'DTEND')),
          ...(closing ? { closingBalance: closing } : {}),
        });
      }
      return out.finish();
    },
  };
}

function addTrn(out: ResultBuilder, t: Node, row: number, cur: string, acct?: string): void {
  const raw: Record<string, string> = {};
  for (const c of t.children) if (c.text.trim()) raw[c.name] = c.text.trim();
  const date = compactDate(textAt(t, 'DTPOSTED'));
  const amount = ofxAmount(textAt(t, 'TRNAMT'));
  if (!date || amount === undefined) {
    out.errors.push({
      row,
      code: 'invalid_transaction',
      message: 'STMTTRN without valid DTPOSTED/TRNAMT',
    });
    return;
  }
  // <CURRENCY>: TRNAMT is in CURSYM, CURDEF = TRNAMT × CURRATE. <ORIGCURRENCY>: TRNAMT is in CURDEF.
  const inForeign = find(t, 'CURRENCY');
  const curNode = inForeign ?? find(t, 'ORIGCURRENCY');
  const foreign = textAt(curNode, 'CURSYM');
  const rate = textAt(curNode, 'CURRATE')?.replace(',', '.');
  let signedAmount = amount;
  let originalAmount: string | undefined;
  const warnings: ImportIssue[] = [];
  if (foreign && rate && isKnownCurrency(foreign) && isKnownCurrency(cur) && /[1-9]/.test(rate)) {
    try {
      if (inForeign) {
        originalAmount = amount;
        signedAmount = convert(
          { amount: toCurrencyScale(amount, foreign), currency: foreign },
          cur,
          rate,
        ).amount;
        warnings.push({
          row,
          field: 'amount',
          code: 'converted_amount',
          message: `converted from ${foreign} at ${rate}`,
        });
      } else {
        const local = { amount: toCurrencyScale(amount.replace(/^-/, ''), cur), currency: cur };
        originalAmount = convertInverse(local, foreign, rate).amount;
      }
    } catch (e) {
      out.errors.push({
        row,
        field: 'amount',
        code: 'amount_precision',
        message: (e as Error).message,
      });
      return;
    }
  }
  const name = textAt(t, 'NAME') ?? textAt(t, 'PAYEE/NAME');
  const memo = textAt(t, 'MEMO');
  out.add({
    rowNumber: row,
    postingDate: date,
    valueDate: compactDate(textAt(t, 'DTUSER')),
    signedAmount,
    currency: cur,
    description: [name, memo].filter(Boolean).join(' '),
    counterparty: name,
    bankReference: textAt(t, 'FITID') ?? textAt(t, 'CHECKNUM'),
    accountRef: acct,
    exchangeRate: foreign ? rate : undefined,
    originalAmount,
    originalCurrency: foreign,
    raw,
    warnings,
    confidence: warnings.length ? 0.9 : 1,
  });
}
