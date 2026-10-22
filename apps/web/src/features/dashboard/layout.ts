// Dashboard widget catalog (PLAN §32) and the saved per-profile layout (settings key
// "dashboard.layout" via FinanceOps.get/setDashboardLayout).

export const WIDGETS = [
  {
    id: 'total-balance',
    titleKey: 'dashboard.widget.totalBalance',
    title: 'Total balance',
    wide: false,
  },
  {
    id: 'month-income',
    titleKey: 'dashboard.widget.monthIncome',
    title: 'Income this month',
    wide: false,
  },
  {
    id: 'month-expenses',
    titleKey: 'dashboard.widget.monthExpenses',
    title: 'Expenses this month',
    wide: false,
  },
  {
    id: 'net-cash-flow',
    titleKey: 'dashboard.widget.netCashFlow',
    title: 'Net cash flow',
    wide: false,
  },
  {
    id: 'savings-rate',
    titleKey: 'dashboard.widget.savingsRate',
    title: 'Savings rate',
    wide: false,
  },
  {
    id: 'month-end',
    titleKey: 'dashboard.widget.monthEnd',
    title: 'Projected month-end balance',
    wide: false,
  },
  { id: 'accounts', titleKey: 'dashboard.widget.accounts', title: 'Account balances', wide: true },
  {
    id: 'upcoming-bills',
    titleKey: 'dashboard.widget.upcomingBills',
    title: 'Upcoming bills',
    wide: false,
  },
  { id: 'budgets', titleKey: 'dashboard.widget.budgets', title: 'Budget utilization', wide: false },
  {
    id: 'categories',
    titleKey: 'dashboard.widget.categories',
    title: 'Spending by category',
    wide: false,
  },
  { id: 'trends', titleKey: 'dashboard.widget.trends', title: 'Spending trend', wide: true },
  { id: 'recent', titleKey: 'dashboard.widget.recent', title: 'Recent transactions', wide: false },
  { id: 'largest', titleKey: 'dashboard.widget.largest', title: 'Largest expenses', wide: false },
  {
    id: 'subscriptions',
    titleKey: 'dashboard.widget.subscriptions',
    title: 'Recurring subscriptions',
    wide: false,
  },
  { id: 'goals', titleKey: 'dashboard.widget.goals', title: 'Savings goals', wide: false },
  { id: 'insights', titleKey: 'dashboard.widget.insights', title: 'Insights', wide: false },
  {
    id: 'import-coverage',
    titleKey: 'dashboard.widget.importCoverage',
    title: 'Import coverage',
    wide: false,
  },
  { id: 'sync-health', titleKey: 'dashboard.widget.syncHealth', title: 'Sync health', wide: false },
] as const;

export type WidgetId = (typeof WIDGETS)[number]['id'];

export interface DashboardLayout {
  order: WidgetId[];
  hidden: WidgetId[];
}

const IDS = WIDGETS.map((w) => w.id) as WidgetId[];
const isId = (x: unknown): x is WidgetId => IDS.includes(x as WidgetId);

export const defaultLayout = (): DashboardLayout => ({ order: [...IDS], hidden: [] });

/**
 * Accept whatever was saved (possibly by an older version): drop unknown ids and duplicates,
 * append widgets added since, keep the user's order and hidden set.
 */
export function normalizeLayout(saved: unknown): DashboardLayout {
  const s = (saved ?? {}) as { order?: unknown; hidden?: unknown };
  const order = Array.isArray(s.order) ? [...new Set(s.order.filter(isId))] : [];
  for (const id of IDS) if (!order.includes(id)) order.push(id);
  const hidden = Array.isArray(s.hidden) ? [...new Set(s.hidden.filter(isId))] : [];
  return { order, hidden };
}

export function moveWidget(l: DashboardLayout, id: WidgetId, to: number): DashboardLayout {
  const order = l.order.filter((x) => x !== id);
  order.splice(Math.max(0, Math.min(to, order.length)), 0, id);
  return { ...l, order };
}

export function toggleWidget(l: DashboardLayout, id: WidgetId): DashboardLayout {
  return {
    ...l,
    hidden: l.hidden.includes(id) ? l.hidden.filter((x) => x !== id) : [...l.hidden, id],
  };
}
