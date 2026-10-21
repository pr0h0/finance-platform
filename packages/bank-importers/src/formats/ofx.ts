// OFX 1.x (SGML) and 2.x (XML); QFX is OFX with Intuit headers. Bank and credit-card statements.
import { convert, convertInverse } from '@finplat/finance-engine';
import {
  type BankImporter,
  decodeBytes,
  ImportError,
  type ImportIssue,
  isKnownCurrency,
  ResultBuilder,
  readAll,
  toCurrencyScale,
} from '@finplat/importer-sdk';
import { children, find, findAll, type Node, parseMarkup, textAt } from './markup.ts';
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
      const bytes = await readAll(input, ctx);
      // OFX 1.x declares CHARSET:1252 etc.; the auto detector covers UTF-8 and CE code pages.
      const text = decodeBytes(bytes, ctx.encoding ?? 'auto');
      const body = text.slice(Math.max(0, text.search(/<OFX>/i)));
      if (!/<OFX>/i.test(body)) throw new ImportError('invalid_ofx', 'no <OFX> element');
      const sgml = !/<\?xml/i.test(text.slice(0, 200));
      const root = parseMarkup(sgml ? upperTags(body) : body, { sgml });
      const stmts = [...findAll(root, 'STMTRS'), ...findAll(root, 'CCSTMTRS')];
      if (stmts.length === 0)
        out.errors.push({ code: 'no_statement', message: 'no bank or card statement' });
      let row = 0;
      for (const s of stmts) {
        const cur = textAt(s, 'CURDEF') ?? ctx.accountCurrency ?? '';
        const acct = textAt(s, 'BANKACCTFROM/ACCTID') ?? textAt(s, 'CCACCTFROM/ACCTID');
        const list = find(s, 'BANKTRANLIST');
        const closing = ofxAmount(textAt(s, 'LEDGERBAL/BALAMT'));
        out.statements.push({
          accountRef: acct,
          currency: cur,
          periodStart: compactDate(textAt(list, 'DTSTART')),
          periodEnd: compactDate(textAt(list, 'DTEND')),
          ...(closing ? { closingBalance: closing } : {}),
        });
        for (const t of children(list, 'STMTTRN')) {
          row++;
          addTrn(out, t, row, cur, acct);
        }
      }
      return out.finish();
    },
  };
}

// SGML OFX tags are case-insensitive; normalise tag names (not text) to upper case.
function upperTags(s: string): string {
  return s.replace(
    /<(\/?)([A-Za-z0-9.]+)/g,
    (_, slash: string, n: string) => `<${slash}${n.toUpperCase()}`,
  );
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
