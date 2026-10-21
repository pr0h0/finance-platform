// Exchange-rate lookup and valuation over historical snapshots. Shared with Go via
// packages/test-fixtures/conformance/fx_lookup.json.
//
// Valuation policy (PLAN §19):
// - Flows (income, expenses, analytics) use the rate effective on the transaction's booking date.
// - Balances / net worth use the rate effective on the valuation date.
// - "Effective on D" = the snapshot with the latest rateDate <= D (no future rates). Same date:
//   manual beats fixed beats provider. EUR<->BAM uses the fixed 1.95583 parity on every date unless a
//   manual override is dated exactly that day. Direct vs inverse: newer wins, ties prefer direct.
//   A cross rate reports the oldest leg's date and its weakest source (provider < manual < fixed).
// - Lookup order: identity, fixed EUR/BAM, direct (base=from) or inverse (base=to) snapshot —
//   the newer one wins, ties prefer direct — then triangulation through EUR (from->EUR->to).
// - The composite rate is kept as an exact rational; the converted amount is rounded once.
import { currencyScale, EUR_BAM_FIXED_RATE } from './currencies.ts';
import { divRound, formatDecimal, parseDecimal, pow10, type RoundingMode } from './decimal.ts';
import { DEFAULT_ROUNDING, fromMinor, type Money, toMinor } from './money.ts';

export interface RateSnapshot {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string; // 1 base = rate quote
  rateDate: string;
  source: 'provider' | 'manual' | 'fixed';
}

export interface ResolvedRate {
  from: string;
  to: string;
  num: bigint; // exact rate = num / den units of `to` per 1 `from`
  den: bigint;
  rate: string; // num/den rounded half_up to 18 places, for display/storage (NUMERIC(38,18))
  rateDate: string;
  source: 'provider' | 'manual' | 'fixed';
  inverse: boolean; // true when derived from a snapshot quoted the other way
  via: string | null; // pivot currency when triangulated
}

export interface RateBook {
  resolve(from: string, to: string, date: string): ResolvedRate | null;
}

const SOURCE_RANK = { manual: 2, fixed: 1, provider: 0 } as const;

export function rational(rate: string): { num: bigint; den: bigint } {
  const d = parseDecimal(rate);
  if (d.units <= 0n) throw new Error(`rate must be positive: ${rate}`);
  return { num: d.units, den: pow10(d.scale) };
}

function finish(
  from: string,
  to: string,
  num: bigint,
  den: bigint,
  rest: Omit<ResolvedRate, 'from' | 'to' | 'num' | 'den' | 'rate'>,
): ResolvedRate {
  return {
    from,
    to,
    num,
    den,
    rate: formatDecimal({ units: divRound(num * pow10(18), den, 'half_up'), scale: 18 }).replace(
      /\.?0+$/,
      '',
    ),
    ...rest,
  };
}

export function createRateBook(snapshots: readonly RateSnapshot[]): RateBook {
  // Per pair "BASE/QUOTE": snapshots sorted by date asc, then source rank asc (best last).
  const byPair = new Map<string, RateSnapshot[]>();
  for (const s of snapshots) {
    const k = `${s.baseCurrency}/${s.quoteCurrency}`;
    const list = byPair.get(k) ?? [];
    list.push(s);
    byPair.set(k, list);
  }
  for (const list of byPair.values()) {
    list.sort((a, b) =>
      a.rateDate === b.rateDate
        ? SOURCE_RANK[a.source] - SOURCE_RANK[b.source]
        : a.rateDate < b.rateDate
          ? -1
          : 1,
    );
  }
  const latest = (base: string, quote: string, date: string): RateSnapshot | null => {
    const list = byPair.get(`${base}/${quote}`);
    if (!list) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid] as RateSnapshot).rateDate <= date) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? null : (list[found] as RateSnapshot);
  };

  const single = (from: string, to: string, date: string): ResolvedRate | null => {
    if (from === to)
      return finish(from, to, 1n, 1n, {
        rateDate: date,
        source: 'fixed',
        inverse: false,
        via: null,
      });
    if ((from === 'EUR' && to === 'BAM') || (from === 'BAM' && to === 'EUR')) {
      const d = latest(from, to, date);
      const i = latest(to, from, date);
      const manual = [d, i].find((x) => x && x.source === 'manual' && x.rateDate === date);
      if (manual) {
        const r = rational(manual.rate);
        const inv = manual.baseCurrency !== from;
        return finish(from, to, inv ? r.den : r.num, inv ? r.num : r.den, {
          rateDate: date,
          source: 'manual',
          inverse: inv,
          via: null,
        });
      }
      const r = rational(EUR_BAM_FIXED_RATE);
      const inverse = from === 'BAM';
      return finish(from, to, inverse ? r.den : r.num, inverse ? r.num : r.den, {
        rateDate: date,
        source: 'fixed',
        inverse,
        via: null,
      });
    }
    const d = latest(from, to, date);
    const i = latest(to, from, date);
    if (d && (!i || d.rateDate >= i.rateDate)) {
      const r = rational(d.rate);
      return finish(from, to, r.num, r.den, {
        rateDate: d.rateDate,
        source: d.source,
        inverse: false,
        via: null,
      });
    }
    if (i) {
      const r = rational(i.rate);
      return finish(from, to, r.den, r.num, {
        rateDate: i.rateDate,
        source: i.source,
        inverse: true,
        via: null,
      });
    }
    return null;
  };

  return {
    resolve(from, to, date) {
      const direct = single(from, to, date);
      if (direct || from === 'EUR' || to === 'EUR') return direct;
      const a = single(from, 'EUR', date);
      const b = a && single('EUR', to, date);
      if (!a || !b) return null;
      // the cross rate reports its weakest leg: provider < manual < fixed
      const source = [a.source, b.source].includes('provider')
        ? 'provider'
        : [a.source, b.source].includes('manual')
          ? 'manual'
          : 'fixed';
      return finish(from, to, a.num * b.num, a.den * b.den, {
        rateDate: a.rateDate < b.rateDate ? a.rateDate : b.rateDate,
        source,
        inverse: a.inverse || b.inverse,
        via: 'EUR',
      });
    },
  };
}

/** Convert with a resolved rate, rounding once to the target scale. */
export function convertResolved(
  m: Money,
  r: ResolvedRate,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  if (m.currency !== r.from) throw new Error(`rate is for ${r.from}, got ${m.currency}`);
  const sf = currencyScale(r.from) ?? 0;
  const st = currencyScale(r.to);
  if (st === undefined) throw new Error(`unknown currency: ${r.to}`);
  return fromMinor(divRound(toMinor(m) * r.num * pow10(st), r.den * pow10(sf), mode), r.to);
}

/** (money, date) -> money in the reporting currency, or null when no rate is available. */
export type ToReporting = (m: Money, date: string) => Money | null;

export function reportingConverter(
  book: RateBook,
  currency: string,
  mode: RoundingMode = DEFAULT_ROUNDING,
): ToReporting {
  return (m, date) => {
    if (m.currency === currency) return m;
    const r = book.resolve(m.currency, currency, date);
    return r ? convertResolved(m, r, mode) : null;
  };
}

/** Converter that only handles amounts already in `currency` (no rates). */
export const sameCurrencyOnly =
  (currency: string): ToReporting =>
  (m) =>
    m.currency === currency ? m : null;
