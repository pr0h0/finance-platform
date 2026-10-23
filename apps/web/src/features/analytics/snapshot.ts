// One read of everything the insight pages (dashboard, planning, budgets, analytics, goals,
// subscriptions, reports, notifications) compute on. All numbers come from the DataSource's
// FinanceOps, so local and connected mode behave identically; calculations are the shared
// @finplat/finance-engine / @finplat/forecasting functions (exact money, never floats).
import type * as D from '@finplat/domain';
import {
  createRateBook,
  type LedgerTransaction,
  type PlanOccurrence,
  reportingConverter,
  type ToReporting,
} from '@finplat/finance-engine';
import type { EntityName, FinanceOps } from '@finplat/storage';
import { tNow } from '../../lib/i18n.ts';

export interface Snapshot {
  today: string;
  currency: string; // reporting currency
  ledger: LedgerTransaction[];
  transactions: D.Transaction[];
  accounts: D.Account[];
  categories: D.Category[];
  merchants: D.Merchant[];
  plans: D.PlannedTransaction[];
  schedules: D.RecurrenceSchedule[];
  storedOccurrences: D.PlannedOccurrence[];
  budgets: D.Budget[];
  goals: D.SavingsGoal[];
  contributions: D.SavingsContribution[];
  subscriptions: D.Subscription[];
  settings: Record<string, unknown>;
  convert: ToReporting;
  rateCount: number;
}

export const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function loadSnapshot(
  ops: FinanceOps,
  currency: string,
  today = todayIso(),
): Promise<Snapshot> {
  const [
    ledger,
    accounts,
    categories,
    merchants,
    plans,
    schedules,
    storedOccurrences,
    budgets,
    goals,
    contributions,
    subscriptions,
    settings,
    rates,
  ] = await Promise.all([
    ops.ledger(),
    ops.list('accounts'),
    ops.list('categories'),
    ops.list('merchants'),
    ops.list('planned_transactions'),
    ops.list('recurrence_schedules'),
    // ponytail: planned_occurrences is not in the typed EntityName list, but the generic list()
    // reads any profile table; needed for planned-vs-actual (matched/paid occurrences).
    ops.list('planned_occurrences' as EntityName) as unknown as Promise<D.PlannedOccurrence[]>,
    ops.list('budgets'),
    ops.list('savings_goals'),
    ops.list('savings_contributions'),
    ops.list('subscriptions'),
    ops.getSettings(),
    ops.rateSnapshots(),
  ]);
  const reporting = (settings['reporting.currency'] as string | undefined) ?? currency;
  return {
    today,
    currency: reporting,
    ledger,
    transactions: ledger as unknown as D.Transaction[],
    accounts,
    categories,
    merchants,
    plans,
    schedules,
    storedOccurrences,
    budgets,
    goals,
    contributions,
    subscriptions,
    settings,
    convert: reportingConverter(createRateBook(rates), reporting),
    rateCount: rates.length,
  };
}

/** A converter for another reporting currency (analytics currency switch). */
export async function converterFor(ops: FinanceOps, currency: string): Promise<ToReporting> {
  return reportingConverter(createRateBook(await ops.rateSnapshots()), currency);
}

export const planById = (s: Snapshot) => new Map(s.plans.map((p) => [p.id, p]));
export const accountById = (s: Snapshot) => new Map(s.accounts.map((a) => [a.id, a]));
export const categoryName = (s: Snapshot) => {
  const m = new Map(s.categories.map((c) => [c.id, c.name]));
  return (id: string | null | undefined) =>
    id
      ? (m.get(id) ?? tNow('analytics.unknownCategory', 'Unknown'))
      : tNow('transaction.uncategorized', 'Uncategorized');
};

export type { PlanOccurrence };
