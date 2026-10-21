// Prints fp1 vectors for packages/test-fixtures/imports/fingerprint.json. The committed values
// were cross-checked independently with `printf 'fp1\x1f…' | sha256sum`.
// Run: BUN_WORKDIR=packages/importer-sdk scripts/bun.sh scripts/fp-vectors.ts
import { type FingerprintInput, fingerprint, fingerprintKey } from '../src/fingerprint.ts';

const cases: { name: string; input: FingerprintInput; ordinal: number }[] = [
  {
    name: 'debit with reference',
    input: {
      postingDate: '2025-01-07',
      amount: '45.10',
      direction: 'debit',
      currency: 'EUR',
      bankReference: ' tx 1007 ',
      description: 'Grocery, Market 12',
    },
    ordinal: 1,
  },
  {
    name: 'credit, trailing zeros stripped, currency uppercased',
    input: {
      postingDate: '2025-01-05',
      amount: '2500.00',
      direction: 'credit',
      currency: 'eur',
      bankReference: 'SAL-0001',
      description: 'x',
    },
    ordinal: 1,
  },
  {
    name: 'no reference uses description',
    input: {
      postingDate: '2025-01-03',
      amount: '3.50',
      direction: 'debit',
      currency: 'EUR',
      description: 'Coffee Shop "Bean"',
    },
    ordinal: 1,
  },
  {
    name: 'second identical row gets ordinal 2',
    input: {
      postingDate: '2025-01-03',
      amount: '3.50',
      direction: 'debit',
      currency: 'EUR',
      description: 'COFFEE  shop bean',
    },
    ordinal: 2,
  },
  {
    name: 'placeholder reference NONREF is ignored',
    input: {
      postingDate: '2025-01-03',
      amount: '3.5',
      direction: 'debit',
      currency: 'EUR',
      bankReference: 'NONREF',
      description: 'coffee-shop bean',
    },
    ordinal: 1,
  },
  {
    name: 'diacritics kept, NFKC + lowercase',
    input: {
      postingDate: '2025-01-07',
      amount: '15.50',
      direction: 'debit',
      currency: 'BAM',
      description: 'Ćevapi i ČAJ — Željo',
    },
    ordinal: 1,
  },
  {
    name: 'leading zero kept, trailing zero stripped',
    input: {
      postingDate: '2025-02-01',
      amount: '0.50',
      direction: 'credit',
      currency: 'BAM',
      description: 'Kamata',
    },
    ordinal: 1,
  },
  {
    name: 'zero-decimal currency',
    input: {
      postingDate: '2025-04-05',
      amount: '1000',
      direction: 'credit',
      currency: 'JPY',
      description: 'Yen',
    },
    ordinal: 1,
  },
];

const out = [];
for (const c of cases)
  out.push({
    ...c,
    payload: `${fingerprintKey(c.input)}\x1f${c.ordinal}`,
    expected: await fingerprint(c.input, c.ordinal),
  });
console.log(JSON.stringify(out, null, 2));
