// Starter categories. Mirrors apps/api/internal/categories/module.go `defaults` so local and
// server profiles start the same; keep both lists in sync.
import type { FinanceOps } from '@finplat/storage';

export const DEFAULT_CATEGORIES: {
  kind: 'expense' | 'income';
  name: string;
  children: string[];
}[] = [
  { kind: 'expense', name: 'Housing', children: ['Rent', 'Utilities', 'Maintenance'] },
  { kind: 'expense', name: 'Food', children: ['Groceries', 'Restaurants'] },
  { kind: 'expense', name: 'Transport', children: ['Fuel', 'Public transport', 'Car'] },
  { kind: 'expense', name: 'Health', children: [] },
  { kind: 'expense', name: 'Shopping', children: ['Clothing', 'Electronics'] },
  { kind: 'expense', name: 'Entertainment', children: ['Subscriptions'] },
  { kind: 'expense', name: 'Education', children: [] },
  { kind: 'expense', name: 'Travel', children: [] },
  { kind: 'expense', name: 'Fees & charges', children: ['Bank fees', 'Currency conversion'] },
  { kind: 'expense', name: 'Gifts & donations', children: [] },
  { kind: 'income', name: 'Salary', children: [] },
  { kind: 'income', name: 'Freelance', children: [] },
  { kind: 'income', name: 'Bonus', children: [] },
  { kind: 'income', name: 'Gifts received', children: [] },
  { kind: 'income', name: 'Interest', children: [] },
  { kind: 'income', name: 'Other income', children: [] },
];

/** Creates the starter set when the profile has no categories yet. Returns how many were made. */
export async function seedLocalCategories(
  ops: Pick<FinanceOps, 'list' | 'create'>,
): Promise<number> {
  if ((await ops.list('categories')).some((c) => !c.deletedAt)) return 0;
  let n = 0;
  for (const d of DEFAULT_CATEGORIES) {
    const parent = await ops.create('categories', { name: d.name, kind: d.kind });
    n++;
    for (const child of d.children) {
      await ops.create('categories', { name: child, kind: d.kind, parentId: parent.id });
      n++;
    }
  }
  return n;
}
