import { describe, expect, test } from 'bun:test';
import {
  addDays,
  type Money,
  type PlanLike,
  type ScheduleLike,
  sameCurrencyOnly,
} from '@finplat/finance-engine';
import {
  applyScenario,
  emergencyFundMonths,
  essentialMonthlyFromPlans,
  eventsFromPlans,
  type ForecastInput,
  forecast,
  projectGoal,
  whatIf,
} from './index.ts';

const M = (amount: string, currency = 'BAM'): Money => ({ amount, currency });
const conv = sameCurrencyOnly('BAM');
const plan = (
  p: Partial<PlanLike> & Pick<PlanLike, 'id' | 'kind' | 'amount' | 'dueDate'>,
): PlanLike => ({
  accountId: 'chk',
  toAccountId: null,
  categoryId: null,
  description: p.id,
  recurrenceId: null,
  confidence: 'certain',
  status: 'active',
  ...p,
});

const schedules: ScheduleLike[] = [
  { id: 'r1', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', startDate: '2026-01-01' },
  { id: 'r25', rrule: 'FREQ=MONTHLY;BYMONTHDAY=25', startDate: '2026-01-25' },
];
const plans = [
  plan({
    id: 'rent',
    kind: 'expense',
    amount: M('900.00'),
    dueDate: '2026-01-01',
    recurrenceId: 'r1',
    priority: 'essential',
  }),
  plan({
    id: 'salary',
    kind: 'income',
    amount: M('2000.00'),
    dueDate: '2026-01-25',
    recurrenceId: 'r25',
  }),
  plan({
    id: 'tv',
    kind: 'expense',
    amount: M('600.00'),
    dueDate: '2026-11-10',
    confidence: 'expected',
  }),
];

function input(balance = '500.00'): ForecastInput {
  const { events } = eventsFromPlans(plans, schedules, [], '2026-11-01', '2026-11-30');
  return {
    from: '2026-11-01',
    to: '2026-11-30',
    currency: 'BAM',
    accounts: [{ id: 'chk', currency: 'BAM', balance: M(balance), includeInSafeToSpend: true }],
    events,
    convert: conv,
  };
}

describe('forecast', () => {
  test('12. detects a mid-month negative balance (daily projection, not monthly netting)', () => {
    const f = forecast(input());
    // 500 - 900 rent on the 1st -> -400, -600 tv on the 10th -> -1000, +2000 on the 25th -> 1000
    expect(f.lowest).toEqual({ date: '2026-11-10', amount: M('-1000.00') });
    expect(f.shortfalls).toEqual([{ date: '2026-11-01', amount: M('-1000.00'), accountId: 'chk' }]);
    expect(f.monthEnd).toEqual(M('1000.00'));
    expect(f.days).toHaveLength(30);
    expect(f.days[9]?.events.map((e) => e.sourceId)).toEqual(['tv']);
    expect(f.safeToSpend).toEqual(M('0.00'));
    expect(f.assumptions.length).toBeGreaterThan(3);
  });

  test('what-if never mutates the input and reports deltas', () => {
    const base = input('2000.00');
    const frozen = JSON.stringify(base.events);
    const r = whatIf(base, [
      { removePlannedTransactionId: 'tv' },
      { description: 'Bike', amount: M('-300.00'), date: '2026-11-05', accountId: 'chk' },
      {
        description: 'Side job',
        amount: M('50.00'),
        date: '2026-11-07',
        rrule: 'FREQ=WEEKLY',
        accountId: 'chk',
      },
    ]);
    expect(JSON.stringify(base.events)).toBe(frozen);
    // -tv (+600) -bike (-300) + 4 weekly payments (Nov 7, 14, 21, 28) = +500
    expect(r.delta.end).toEqual(M('500.00'));
    expect(r.scenario.days.find((d) => d.date === '2026-11-05')?.events[0]?.description).toBe(
      'Bike',
    );
    const s = applyScenario(base, []);
    expect(s).not.toBe(base);
    expect(s.events).toEqual(base.events);
  });

  test('safe-to-spend honours the reserve and future commitments', () => {
    const f = forecast({ ...input('3000.00'), reserve: M('200.00') });
    // lowest conservative: 3000 - 900 - 600 = 1500 on the 10th, minus reserve
    expect(f.safeToSpend).toEqual(M('1300.00'));
  });
});

describe('goals and emergency fund', () => {
  test('goal completion from a planned contribution schedule', () => {
    const g = projectGoal(
      { targetAmount: M('1000.00'), startingAmount: M('100.00'), targetDate: '2027-03-01' },
      [
        { amount: M('200.00'), contributionDate: '2026-09-01' },
        { amount: M('-50.00'), contributionDate: '2026-10-01' },
        { amount: M('999.00'), contributionDate: '2026-12-01' }, // future, ignored
      ],
      '2026-10-22',
      { amount: M('250.00'), rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', startDate: '2026-01-01' },
    );
    expect(g.saved).toEqual(M('250.00'));
    expect(g.remaining).toEqual(M('750.00'));
    expect(g.progress).toBe('0.2500');
    expect(g.estimatedCompletionDate).toBe('2027-01-01'); // Nov 1, Dec 1, Jan 1
    expect(g.basis).toBe('plan');
    expect(g.onTrack).toBe(true);
    expect(g.requiredMonthly).toEqual(M('150.00')); // 750 over 5 months
  });
  test('goal estimate from recent history, and completed goals', () => {
    const h = projectGoal(
      { targetAmount: M('1000.00'), startingAmount: M('0.00'), targetDate: null },
      [
        { amount: M('100.00'), contributionDate: '2026-08-01' },
        { amount: M('100.00'), contributionDate: '2026-09-01' },
        { amount: M('100.00'), contributionDate: '2026-10-01' },
      ],
      '2026-10-22',
    );
    expect(h.basis).toBe('history');
    expect(h.estimatedCompletionDate).toBe('2027-05-22'); // 700 left at 100/month -> 7 months
    expect(h.onTrack).toBeNull();
    const done = projectGoal(
      { targetAmount: M('10.00'), startingAmount: M('10.00'), targetDate: null },
      [],
      '2026-10-22',
    );
    expect(done.basis).toBe('complete');
    expect(done.progress).toBe('1.0000');
  });
  test('emergency fund months from essential plans', () => {
    const e = essentialMonthlyFromPlans(plans, schedules, 'BAM', conv, '2026-10-22');
    expect(e).toEqual({ monthly: M('900.00'), complete: true });
    expect(emergencyFundMonths(M('5000.00'), e.monthly)).toBe('5.5');
    expect(emergencyFundMonths(M('5000.00'), M('0.00'))).toBeNull();
  });
});

test('performance: 2-year daily forecast over 200 recurring plans and 5 accounts', () => {
  const ps: PlanLike[] = [];
  const ss: ScheduleLike[] = [];
  for (let i = 0; i < 200; i++) {
    ss.push({
      id: `s${i}`,
      rrule: i % 2 ? 'FREQ=WEEKLY' : `FREQ=MONTHLY;BYMONTHDAY=${(i % 28) + 1}`,
      startDate: '2024-01-01',
    });
    ps.push(
      plan({
        id: `p${i}`,
        kind: i % 5 ? 'expense' : 'income',
        amount: M(`${i + 1}.25`),
        dueDate: '2024-01-01',
        recurrenceId: `s${i}`,
        accountId: `a${i % 5}`,
      }),
    );
  }
  const t0 = performance.now();
  const { events } = eventsFromPlans(ps, ss, [], '2026-11-01', addDays('2026-11-01', 730));
  const f = forecast({
    from: '2026-11-01',
    to: addDays('2026-11-01', 730),
    currency: 'BAM',
    accounts: [0, 1, 2, 3, 4].map((i) => ({ id: `a${i}`, currency: 'BAM', balance: M('1000.00') })),
    events,
    convert: conv,
  });
  expect(f.days).toHaveLength(731);
  expect(performance.now() - t0).toBeLessThan(5000);
});
