// Real LocalFinanceService on a MemoryStore for the insight tests (no mocks).
import { LocalDataSource, MemoryStore } from '@finplat/storage';
import { loadSnapshot } from './snapshot.ts';

export const m = (amount: string, currency = 'BAM') => ({ amount, currency });

export async function seed() {
  const store = new MemoryStore();
  await store.open();
  const ds = new LocalDataSource(store);
  const profile = await ds.createProfile({ name: 'Home', baseCurrency: 'BAM' });
  const ops = ds.profile(profile.id);
  const checking = await ops.create('accounts', {
    name: 'Checking',
    accountType: 'checking',
    currency: 'BAM',
    openingBalance: m('1000.00'),
    openingDate: '2026-01-01',
  });
  const food = await ops.create('categories', { name: 'Food' });
  const salary = await ops.create('categories', { name: 'Salary', kind: 'income' });
  await ops.createTransaction({
    kind: 'income',
    accountId: checking.id,
    amount: m('2000.00'),
    bookingDate: '2026-03-01',
    description: 'Salary',
    categoryId: salary.id,
  });
  await ops.createTransaction({
    kind: 'expense',
    accountId: checking.id,
    amount: m('150.00'),
    bookingDate: '2026-03-05',
    description: 'Market',
    categoryId: food.id,
  });
  await ops.createTransaction({
    kind: 'expense',
    accountId: checking.id,
    amount: m('50.00'),
    bookingDate: '2026-03-20',
    description: 'Bakery',
  });
  const snap = (today = '2026-03-31') => loadSnapshot(ops, 'BAM', today);
  return { ds, ops, profile, checking, food, salary, snap };
}
