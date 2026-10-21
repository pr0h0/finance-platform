import { describe, expect, test } from 'bun:test';
import { LocalDataSource, MemoryStore } from '@finplat/storage';
import { buildGrants } from '../mcp/McpPage.tsx';
import { deviceName, toBaseUrl } from '../onboarding/connect.tsx';
import { DEFAULT_CATEGORIES, seedLocalCategories } from '../onboarding/defaults.ts';
import { mergeConflict } from '../sync/SyncPage.tsx';
import { validateLockSecret } from './SecurityTab.tsx';

describe('app lock secret rules', () => {
  test('PIN must be 4–12 digits and match', () => {
    expect(validateLockSecret('pin', '123', '123')).toContain('4–12');
    expect(validateLockSecret('pin', '12a4', '12a4')).toContain('4–12');
    expect(validateLockSecret('pin', '1234', '1235')).toContain('match');
    expect(validateLockSecret('pin', '1234', '1234')).toBeNull();
  });
  test('password needs 8+ characters', () => {
    expect(validateLockSecret('password', 'short', 'short')).toContain('8');
    expect(validateLockSecret('password', 'long enough', 'long enough')).toBeNull();
  });
});

describe('server connection helpers', () => {
  test('same origin becomes the relative base URL', () => {
    expect(toBaseUrl('https://fin.pr0h0.me', 'https://fin.pr0h0.me')).toBe('');
    expect(toBaseUrl('https://other.example', 'https://fin.pr0h0.me')).toBe(
      'https://other.example',
    );
  });
  test('device names', () => {
    expect(
      deviceName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'),
    ).toBe('Chrome on Linux');
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1')).toBe(
      'Safari on iOS',
    );
    expect(deviceName('')).toBe('Browser');
  });
});

describe('conflict merge', () => {
  test('takes server data and only the picked client fields', () => {
    const merged = mergeConflict(
      {
        fields: ['description', 'notes'],
        serverData: { id: 'x', description: 'server', notes: 's', amount: '1.00' },
        clientData: { id: 'x', description: 'mine', notes: 'c', amount: '9.99' },
      },
      { description: 'client' },
    );
    expect(merged).toEqual({ id: 'x', description: 'mine', notes: 's', amount: '1.00' });
  });
});

describe('MCP grants body', () => {
  const p1 = '00000000-0000-7000-8000-0000000000a1';
  const p2 = '00000000-0000-7000-8000-0000000000a2';
  test('replaces only the edited profile, keeps others, never auto for risky scopes', () => {
    const existing = [
      { id: 'g1', profileId: p2, scope: 'read_aggregates' as const, approval: 'required' as const },
      { id: 'g2', profileId: p1, scope: 'edit_budgets' as const, approval: 'required' as const },
    ];
    const out = buildGrants(
      existing,
      p1,
      {
        read_transactions: { enabled: true, approval: 'required' },
        edit_categories: { enabled: true, approval: 'auto' },
        edit_budgets: { enabled: true, approval: 'auto' }, // auto not allowed here
        edit_goals: { enabled: false, approval: 'required' },
      },
      { accountIds: ['acc'], dateFrom: '2026-01-01', dateTo: null },
    );
    expect(out[0]).toEqual({ profileId: p2, scope: 'read_aggregates', approval: 'required' });
    const mine = out.filter((g) => g.profileId === p1);
    expect(mine.map((g) => [g.scope, g.approval])).toEqual([
      ['read_transactions', 'required'],
      ['edit_categories', 'auto'],
      ['edit_budgets', 'required'],
    ]);
    expect(
      mine.every(
        (g) => g.accountIds?.[0] === 'acc' && g.dateFrom === '2026-01-01' && g.dateTo === null,
      ),
    ).toBe(true);
  });
});

describe('starter categories (local mode)', () => {
  test('creates the same tree as the server, once', async () => {
    const store = new MemoryStore();
    await store.open();
    const ds = new LocalDataSource(store);
    const p = await ds.createProfile({ name: 'T', baseCurrency: 'BAM' });
    const ops = ds.profile(p.id);
    const expected = DEFAULT_CATEGORIES.reduce((n, d) => n + 1 + d.children.length, 0);
    expect(await seedLocalCategories(ops)).toBe(expected);
    expect(await seedLocalCategories(ops)).toBe(0);
    const cats = await ops.list('categories');
    const food = cats.find((c) => c.name === 'Food');
    expect(
      cats
        .filter((c) => c.parentId === food?.id)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['Groceries', 'Restaurants']);
    expect(cats.find((c) => c.name === 'Salary')?.kind).toBe('income');
  });
});
