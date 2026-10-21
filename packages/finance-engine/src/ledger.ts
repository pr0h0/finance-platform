import { fromMinor, type Money, toMinor } from './money.ts';

export interface PostingLike extends Money {
  accountId: string;
}

export interface AccountBalance extends Money {
  accountId: string;
}

/** Reconstruct balances from postings. Output sorted by accountId, then currency. */
export function balances(postings: readonly PostingLike[]): AccountBalance[] {
  const acc = new Map<string, bigint>();
  for (const p of postings) {
    const k = `${p.accountId}\u0000${p.currency}`;
    acc.set(k, (acc.get(k) ?? 0n) + toMinor(p));
  }
  return [...acc.entries()]
    .map(([k, v]) => {
      const [accountId, currency] = k.split('\u0000') as [string, string];
      return { accountId, ...fromMinor(v, currency) };
    })
    .sort((a, b) =>
      a.accountId === b.accountId
        ? a.currency.localeCompare(b.currency)
        : a.accountId.localeCompare(b.accountId),
    );
}

/** Split invariant: split amounts (positive magnitudes) must sum exactly to |total|. */
export function splitsBalance(total: Money, splits: readonly Money[]): boolean {
  let s = 0n;
  for (const x of splits) {
    if (x.currency !== total.currency || toMinor(x) <= 0n) return false;
    s += toMinor(x);
  }
  const t = toMinor(total);
  return s === (t < 0n ? -t : t);
}
