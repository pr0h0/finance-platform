// fp1 dedup fingerprint. Normative spec: docs/importing/fingerprint.md (shared with Go).
import type { Direction } from './types.ts';

export interface FingerprintInput {
  postingDate: string;
  amount: string; // positive magnitude
  direction: Direction;
  currency: string;
  bankReference?: string;
  description?: string;
}

const PLACEHOLDER_REFS = new Set(['NONREF', 'NOTPROVIDED', 'N/A', 'NA', '-', '0']);

export function canonicalAmount(amount: string, direction: Direction): string {
  let [int = '0', frac = ''] = amount.replace(/^[+-]/, '').split('.');
  int = int.replace(/^0+(?=\d)/, '') || '0';
  frac = frac.replace(/0+$/, '');
  const s = frac ? `${int}.${frac}` : int;
  return direction === 'debit' && s !== '0' ? `-${s}` : s;
}

export function canonicalReference(ref: string | undefined): string {
  const r = (ref ?? '').replace(/\s/gu, '').toUpperCase();
  return PLACEHOLDER_REFS.has(r) ? '' : r;
}

export function canonicalDescription(desc: string | undefined): string {
  return (desc ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Base key without the occurrence ordinal. */
export function fingerprintKey(r: FingerprintInput): string {
  const ref = canonicalReference(r.bankReference);
  return [
    'fp1',
    r.postingDate,
    canonicalAmount(r.amount, r.direction),
    r.currency.toUpperCase(),
    ref ? 'ref' : 'desc',
    ref || canonicalDescription(r.description),
  ].join('\x1f');
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fingerprint(r: FingerprintInput, ordinal: number): Promise<string> {
  return `fp1:${await sha256Hex(`${fingerprintKey(r)}\x1f${ordinal}`)}`;
}

/** Fingerprints for one account's records in file order (assigns occurrence ordinals). */
export async function fingerprintAll(records: readonly FingerprintInput[]): Promise<string[]> {
  const seen = new Map<string, number>();
  return Promise.all(
    records.map((r) => {
      const k = fingerprintKey(r);
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      return fingerprint(r, n);
    }),
  );
}
