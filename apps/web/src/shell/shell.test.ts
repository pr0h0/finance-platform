import { describe, expect, test } from 'bun:test';
import { storeNameFor } from '../app/store.ts';
import { resolveTheme } from '../app/theme.ts';
import { translate } from '../lib/i18n.ts';
import { lockDelayMs } from './AppLock.tsx';
import { backupDue } from './Banners.tsx';
import { type Command, filterCommands, GO_KEYS, goTarget } from './CommandPalette.tsx';
import { buildInput, type QuickForm } from './QuickAdd.tsx';

const noop = () => undefined;

describe('command palette filter', () => {
  const cmds: Command[] = [
    { id: 'a', label: 'Go to Transactions', run: noop },
    { id: 'b', label: 'New expense', hint: 'N', run: noop },
    { id: 'c', label: 'Idi na Računi', run: noop },
  ];
  test('empty query returns everything in order', () => {
    expect(filterCommands(cmds, '  ').map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
  test('every word must match, case and diacritics ignored', () => {
    expect(filterCommands(cmds, 'go trans').map((c) => c.id)).toEqual(['a']);
    expect(filterCommands(cmds, 'racuni').map((c) => c.id)).toEqual(['c']);
    expect(filterCommands(cmds, 'go expense')).toEqual([]);
  });
  test('prefix matches rank first', () => {
    expect(filterCommands(cmds, 'n').map((c) => c.id)[0]).toBe('b');
  });
});

describe('quick entry input', () => {
  const accounts = [
    { id: '00000000-0000-7000-8000-000000000001', currency: 'BAM' },
    { id: '00000000-0000-7000-8000-000000000002', currency: 'EUR' },
    { id: '00000000-0000-7000-8000-000000000003', currency: 'BAM' },
  ];
  const base: QuickForm = {
    kind: 'expense',
    accountId: accounts[0]?.id ?? '',
    toAccountId: '',
    amount: '12,5',
    toAmount: '',
    categoryId: '',
    bookingDate: '2026-10-22',
    description: ' Bakery ',
    merchantId: null,
  };
  const parse = (s: string) =>
    /^-?\d+(,\d+)?$/.test(s.trim()) ? s.trim().replace(',', '.') : null;

  test('expense: localized amount normalized to the currency scale, no floats', () => {
    const i = buildInput(base, accounts, parse);
    expect(i.amount).toEqual({ amount: '12.50', currency: 'BAM' });
    expect(i.kind).toBe('expense');
    expect(i.description).toBe('Bakery');
    expect(i.categoryId).toBeNull();
  });
  test('rejects zero, negative, garbage and excess decimals', () => {
    for (const amount of ['0', '0,00', '-5', 'abc', ''])
      expect(() => buildInput({ ...base, amount }, accounts, parse)).toThrow('greater than zero');
    expect(() => buildInput({ ...base, amount: '1,005' }, accounts, parse)).toThrow(
      'decimal places',
    );
  });
  test('same-currency transfer stays a transfer', () => {
    const i = buildInput(
      { ...base, kind: 'transfer', toAccountId: accounts[2]?.id ?? '', amount: '100' },
      accounts,
      parse,
    );
    expect(i.kind).toBe('transfer');
    expect(i.toAccountId).toBe(accounts[2]?.id);
    expect('categoryId' in i).toBe(false);
  });
  test('cross-currency transfer needs the received amount and becomes fx', () => {
    const f = {
      ...base,
      kind: 'transfer' as const,
      toAccountId: accounts[1]?.id ?? '',
      amount: '195,58',
    };
    expect(() => buildInput(f, accounts, parse)).toThrow('amount received in EUR');
    const i = buildInput({ ...f, toAmount: '100' }, accounts, parse);
    expect(i.kind).toBe('fx');
    expect(i.toAmount).toEqual({ amount: '100.00', currency: 'EUR' });
  });
  test('transfer to the same account is refused', () => {
    expect(() =>
      buildInput({ ...base, kind: 'transfer', toAccountId: base.accountId }, accounts, parse),
    ).toThrow('different destination');
  });
});

describe('backup reminder and lock backoff', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  test('backupDue', () => {
    expect(backupDue(null, 7, now)).toBe(true);
    expect(backupDue(null, 0, now)).toBe(false);
    expect(backupDue('2026-10-20T12:00:00Z', 7, now)).toBe(false);
    expect(backupDue('2026-10-14T12:00:00Z', 7, now)).toBe(true);
  });
  test('lockDelayMs grows after three failures and is capped', () => {
    expect([0, 1, 2].map(lockDelayMs)).toEqual([0, 0, 0]);
    expect(lockDelayMs(3)).toBe(1000);
    expect(lockDelayMs(5)).toBe(4000);
    expect(lockDelayMs(50)).toBe(300_000);
  });
});

describe('app helpers', () => {
  test('theme resolution', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
  test('one cache database per server', () => {
    expect(storeNameFor('https://fin.pr0h0.me')).toBe('finplat@fin.pr0h0.me');
    expect(storeNameFor('http://localhost:3811/sub')).toBe('finplat@localhost:3811');
  });
  test('translation falls back to English text and interpolates', () => {
    expect(translate('bs', 'nav.dashboard', 'Dashboard')).toBe('Pregled');
    expect(translate('bs', 'no.such.key', 'Hello {{name}}', { name: 'Ana' })).toBe('Hello Ana');
    expect(translate('en', 'nav.dashboard', 'Dashboard')).toBe('Dashboard');
  });
});

describe('G shortcuts', () => {
  test('every key maps back to one section', () => {
    const keys = Object.values(GO_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [id, k] of Object.entries(GO_KEYS)) expect(goTarget(k.toUpperCase())).toBe(id);
    expect(goTarget('z')).toBeUndefined();
  });
});
