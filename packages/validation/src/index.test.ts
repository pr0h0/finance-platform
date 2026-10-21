import { expect, test } from 'bun:test';
import { isoDate, moneySchema, profileInput, registerRequest, transactionCreate } from './index.ts';

const base = {
  kind: 'expense',
  accountId: '0190f1c2-0000-7000-8000-000000000001',
  amount: { amount: '150.00', currency: 'BAM' },
  bookingDate: '2026-02-28',
};

test('money normalizes and rejects extra precision', () => {
  expect(moneySchema.parse({ amount: '1.5', currency: 'BAM' })).toEqual({
    amount: '1.50',
    currency: 'BAM',
  });
  expect(moneySchema.safeParse({ amount: '1.505', currency: 'EUR' }).success).toBe(false);
  expect(moneySchema.safeParse({ amount: 1.5, currency: 'EUR' }).success).toBe(false);
});

test('dates must be real calendar dates', () => {
  expect(isoDate.safeParse('2026-02-29').success).toBe(false);
  expect(isoDate.safeParse('2028-02-29').success).toBe(true);
});

test('splits must sum to the amount', () => {
  const ok = transactionCreate.safeParse({
    ...base,
    splits: [
      { categoryId: null, amount: { amount: '95.40', currency: 'BAM' } },
      { categoryId: null, amount: { amount: '32.50', currency: 'BAM' } },
      { categoryId: null, amount: { amount: '22.10', currency: 'BAM' } },
    ],
  });
  expect(ok.success).toBe(true);
  const bad = transactionCreate.safeParse({
    ...base,
    splits: [{ categoryId: null, amount: { amount: '149.99', currency: 'BAM' } }],
  });
  expect(bad.success).toBe(false);
});

test('transfers need a different destination account', () => {
  expect(transactionCreate.safeParse({ ...base, kind: 'transfer' }).success).toBe(false);
  expect(
    transactionCreate.safeParse({ ...base, kind: 'transfer', toAccountId: base.accountId }).success,
  ).toBe(false);
});

test('registration mirrors the server password and email rules', () => {
  expect(
    registerRequest.safeParse({ email: 'a@example.com', password: 'twelve chars' }).success,
  ).toBe(true);
  expect(registerRequest.safeParse({ email: 'a@example.com', password: 'short' }).success).toBe(
    false,
  );
  expect(registerRequest.safeParse({ email: 'nope', password: 'twelve chars' }).success).toBe(
    false,
  );
});

test('profile input validates currency and week start', () => {
  expect(
    profileInput.safeParse({ name: 'Personal', baseCurrency: 'BAM', weekStart: 1 }).success,
  ).toBe(true);
  expect(profileInput.safeParse({ name: '', baseCurrency: 'BAM' }).success).toBe(false);
  expect(profileInput.safeParse({ name: 'X', weekStart: 7 }).success).toBe(false);
});
