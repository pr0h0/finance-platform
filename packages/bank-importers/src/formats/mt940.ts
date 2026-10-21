// SWIFT MT940 customer statement. Line-based and streamed: memory is bounded by one statement.
import {
  type BankImporter,
  decodeStream,
  type ImportIssue,
  isoDate,
  lines,
  ResultBuilder,
  type StatementInfo,
  type TextEncodingName,
} from '@finplat/importer-sdk';
import { ext, headText, manifest } from './util.ts';

const yymmdd = (s: string): string | undefined => {
  const y = Number(s.slice(0, 2));
  return isoDate(y < 70 ? 2000 + y : 1900 + y, Number(s.slice(2, 4)), Number(s.slice(4, 6)));
};

/** MT940 amounts: digits with ',' as decimal mark ("1234,5" or "100,"). */
const mtAmount = (s: string) => {
  const [i = '0', f = ''] = s.split(',');
  return f ? `${i}.${f}` : i;
};

// :60F:C250101EUR1234,56
const BAL = /^([CD])(\d{6})([A-Z]{3})(\d+,\d*)$/;
// :61:2501150115D12,50NTRFNONREF//B123
const LINE61 =
  /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+,\d*)([A-Z][A-Z0-9]{3})([^/]*?)(?:\/\/(.*))?$/;

interface Field {
  tag: string;
  value: string;
  line: number;
}

export function mt940Importer(): BankImporter {
  const m = manifest({
    id: 'generic-mt940',
    version: '1.0.0',
    name: 'SWIFT MT940',
    formats: ['mt940'],
    status: 'stable',
    limitations: [
      ':86: is free text whose sub-field layout differs per bank; it is used as the description as-is.',
    ],
  });
  return {
    manifest: m,
    async detect(input) {
      const head = await headText(input, 4096);
      if (/^:20:/m.test(head) && /^:(60F|60M|61):/m.test(head))
        return { confidence: 0.95, format: 'mt940', reason: ':20:/:60F: tags' };
      if (['sta', 'mt940', '940'].includes(ext(input)) && /^:\d{2}[A-Z]?:/m.test(head))
        return { confidence: 0.6, format: 'mt940' };
      return { confidence: 0 };
    },
    async parse(input, ctx) {
      const out = new ResultBuilder(m, 'mt940', ctx);
      const enc: { encoding?: TextEncodingName } = {};
      let fields: Field[] = [];
      let n = 0;
      const flush = () => {
        if (fields.length > 0) statement(out, fields);
        fields = [];
      };
      for await (const l of lines(decodeStream(input, ctx, enc))) {
        n++;
        const t = l.trimEnd();
        if (t === '-' || t.startsWith('-}') || t === '') {
          if (t !== '') flush();
          continue;
        }
        if (t.startsWith('{')) {
          // SWIFT envelope "{1:...}{2:...}{4:" — the block 4 content starts on the next line.
          continue;
        }
        const f = /^:(\d{2}[A-Z]?):(.*)$/.exec(t);
        if (f) {
          if (f[1] === '20' && fields.some((x) => x.tag === '61' || x.tag === '62F')) flush();
          fields.push({ tag: f[1] as string, value: f[2] as string, line: n });
        } else if (fields.length > 0) {
          (fields[fields.length - 1] as Field).value += `\n${t}`;
        }
      }
      flush();
      out.encoding = enc.encoding;
      return out.finish();
    },
  };
}

function statement(out: ResultBuilder, fields: Field[]): void {
  const get = (tag: string) => fields.find((f) => f.tag === tag)?.value;
  const ref = get('20')?.trim();
  const acct = get('25')?.trim();
  const st: StatementInfo = { ref, accountRef: acct };
  const ob = BAL.exec((get('60F') ?? get('60M') ?? '').trim());
  const cb = BAL.exec((get('62F') ?? get('62M') ?? '').trim());
  const sign = (b: RegExpExecArray) =>
    b[1] === 'D' ? `-${mtAmount(b[4] as string)}` : mtAmount(b[4] as string);
  if (ob) {
    st.openingBalance = sign(ob);
    st.currency = ob[3];
    st.periodStart = yymmdd(ob[2] as string);
  }
  if (cb) {
    st.closingBalance = sign(cb);
    st.currency ??= cb[3];
    st.periodEnd = yymmdd(cb[2] as string);
  }
  if (!st.currency)
    out.errors.push({
      code: 'missing_balance',
      message: `statement ${ref ?? ''} has no :60F: currency`,
    });
  out.statements.push(st);
  fields.forEach((f, i) => {
    if (f.tag !== '61') return;
    const [first = '', ...rest] = f.value.split('\n');
    const mm = LINE61.exec(first.trim());
    if (!mm) {
      out.errors.push({ row: f.line, code: 'invalid_61', message: `cannot parse :61: ${first}` });
      return;
    }
    const valueDate = yymmdd(mm[1] as string);
    let postingDate = valueDate;
    const warnings: ImportIssue[] = [];
    if (mm[2] && valueDate) {
      // Entry date MMDD has no year: take the value date's year, adjusting across New Year.
      let y = Number(valueDate.slice(0, 4));
      const em = Number(mm[2].slice(0, 2));
      const vm = Number(valueDate.slice(5, 7));
      if (em === 12 && vm === 1) y--;
      else if (em === 1 && vm === 12) y++;
      postingDate = isoDate(y, em, Number(mm[2].slice(2, 4))) ?? valueDate;
    }
    if (!postingDate) {
      out.errors.push({ row: f.line, code: 'invalid_date', message: `bad date in :61: ${first}` });
      return;
    }
    const mark = mm[3] as string;
    const debit = mark === 'D' || mark === 'RC';
    if (mark.startsWith('R'))
      warnings.push({ row: f.line, code: 'reversal', message: `reversal ${mark}` });
    const next = fields[i + 1];
    const info = next?.tag === '86' ? next.value.replace(/\n/g, ' ') : '';
    const custRef = (mm[7] as string).trim();
    const bankRef = mm[8]?.trim();
    out.add({
      rowNumber: f.line,
      postingDate,
      valueDate,
      amount: mtAmount(mm[5] as string),
      direction: debit ? 'debit' : 'credit',
      currency: st.currency ?? '',
      description: [info, rest.join(' ')].filter(Boolean).join(' ').trim() || custRef,
      bankReference: bankRef || custRef,
      accountRef: acct,
      statementRef: ref,
      raw: { '61': f.value, ...(info ? { '86': next?.value ?? '' } : {}) },
      warnings,
    });
  });
}
