import { currencyScale, money } from '@finplat/finance-engine';

/** Tokens allowed in template date formats; anything else must be one of DATE_LITERALS. */
const DATE_TOKENS = ['YYYY', 'YY', 'MM', 'M', 'DD', 'D'] as const;
const DATE_LITERALS = './- ';
export const DATE_FORMAT_RE = /^(YYYY|YY|MM|M|DD|D|[./\- ])+$/;

interface CompiledDate {
  re: RegExp;
  order: (typeof DATE_TOKENS)[number][];
}
const cache = new Map<string, CompiledDate>();

function compile(format: string): CompiledDate {
  const hit = cache.get(format);
  if (hit) return hit;
  if (!DATE_FORMAT_RE.test(format)) throw new Error(`invalid date format: ${format}`);
  let src = '^';
  const order: CompiledDate['order'] = [];
  for (let i = 0; i < format.length; ) {
    const tok = DATE_TOKENS.find((t) => format.startsWith(t, i));
    if (tok) {
      order.push(tok);
      src += tok === 'YYYY' ? '(\\d{4})' : tok.length === 2 ? '(\\d{2})' : '(\\d{1,2})';
      i += tok.length;
    } else {
      const ch = format[i] as string;
      if (!DATE_LITERALS.includes(ch)) throw new Error(`invalid date format: ${format}`);
      src += ch === ' ' ? '\\s+' : `\\${ch}`;
      i++;
    }
  }
  // A trailing time part ("10:22", "T10:22:00Z") is allowed and ignored: dates stay as printed.
  src += '(?:$|[\\sT])';
  const c = { re: new RegExp(src), order };
  cache.set(format, c);
  return c;
}

/** Parse a bank date to YYYY-MM-DD, or undefined if it does not match / is not a real day. */
export function parseDate(value: string, format: string): string | undefined {
  const { re, order } = compile(format);
  const m = re.exec(value.trim());
  if (!m) return undefined;
  let y = 0;
  let mo = 0;
  let d = 0;
  order.forEach((tok, i) => {
    const n = Number(m[i + 1]);
    if (tok === 'YYYY') y = n;
    else if (tok === 'YY') y = n < 70 ? 2000 + n : 1900 + n;
    else if (tok[0] === 'M') mo = n;
    else d = n;
  });
  return isoDate(y, mo, d);
}

export function isoDate(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2999) return undefined;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface NumberFormat {
  decimalSeparator: '.' | ',';
  thousandsSeparator: '' | '.' | ',' | ' ' | "'";
}

/**
 * Parse a printed amount into a signed plain decimal string ("-1234.5"). Accepts leading +/-,
 * trailing minus ("12,00-"), accounting parentheses and surrounding whitespace. Never uses floats.
 */
export function parseAmount(value: string, fmt: NumberFormat): string | undefined {
  let s = value.replace(/[  ]/g, ' ').trim();
  if (s === '') return undefined;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-') || s.startsWith('+')) {
    neg = neg !== (s[0] === '-');
    s = s.slice(1).trim();
  } else if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1).trim();
  }
  if (fmt.thousandsSeparator !== '') s = s.split(fmt.thousandsSeparator).join('');
  if (fmt.thousandsSeparator === ' ' || fmt.thousandsSeparator === "'") s = s.replace(/\s/g, '');
  if (fmt.decimalSeparator === ',') s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  s = s.replace(/^0+(?=\d)/, '');
  return neg && /[1-9]/.test(s) ? `-${s}` : s;
}

/** Rescale to the currency's minor units; throws on unknown currency or extra precision. */
export function toCurrencyScale(amount: string, currency: string): string {
  return money(amount, currency).amount;
}

export function isKnownCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && currencyScale(code) !== undefined;
}

/** Common currency aliases printed by Balkan banks. */
const CURRENCY_ALIASES: Record<string, string> = { KM: 'BAM', EURO: 'EUR', DIN: 'RSD', KN: 'HRK' };

export function normalizeCurrency(value: string): string {
  const v = value.trim().toUpperCase();
  return CURRENCY_ALIASES[v] ?? v;
}
