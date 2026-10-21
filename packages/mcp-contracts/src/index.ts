// MCP tool contracts (PLAN §28–29). Identical for the remote endpoint (/mcp on the Go API) and the
// future local desktop MCP server. The Go server mirrors these input schemas; the JSON Schemas
// produced by toolJsonSchemas() are what MCP clients see in tools/list.
import type { McpScope } from '@finplat/domain';
import { decimal, isoDate, moneySchema, positiveMoney, uuid, z } from '@finplat/validation';

const dateRange = { dateFrom: isoDate.optional(), dateTo: isoDate.optional() };
const scopeFilters = {
  profileId: uuid.optional().describe('Defaults to the only profile granted to the client'),
  accountIds: z.array(uuid).max(100).optional(),
};
const currency = z
  .string()
  .length(3)
  .optional()
  .describe('Reporting currency; defaults to profile base currency');
const page = {
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
};

/** Every tool result carries completeness info so agents never mistake partial data for totals. */
export const resultMeta = z.object({
  complete: z.boolean(),
  warnings: z.array(z.string()),
  missingRates: z.array(z.object({ from: z.string(), to: z.string(), date: isoDate })).default([]),
  nextCursor: z.string().optional(),
});

const amountRow = z.object({
  key: z.string(),
  label: z.string(),
  amount: moneySchema,
  count: z.number().int(),
});

interface ToolDef {
  description: string;
  readOnly: boolean;
  scopes: McpScope[]; // all required
  input: z.ZodType;
  output: z.ZodType;
}

const proposal = z.object({
  proposalId: uuid,
  status: z.enum(['pending', 'applied']),
  preview: z.record(z.string(), z.unknown()),
  meta: resultMeta,
});

export const TOOLS = {
  // ---------- read-only (§28) ----------
  get_financial_overview: {
    description: 'Balances, net worth, month-to-date income/expenses and upcoming bills.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({ ...scopeFilters, currency, asOf: isoDate.optional() }),
    output: z.object({
      netWorth: moneySchema,
      totalAssets: moneySchema,
      totalLiabilities: moneySchema,
      monthIncome: moneySchema,
      monthExpenses: moneySchema,
      upcoming: z.array(z.object({ date: isoDate, description: z.string(), amount: moneySchema })),
      meta: resultMeta,
    }),
  },
  list_accounts: {
    description: 'Accounts with current balances.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({ ...scopeFilters, includeArchived: z.boolean().default(false) }),
    output: z.object({
      accounts: z.array(
        z.object({ id: uuid, name: z.string(), type: z.string(), balances: z.array(moneySchema) }),
      ),
      meta: resultMeta,
    }),
  },
  get_account_balance: {
    description: 'Balance of one account at a date (from the ledger).',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({ accountId: uuid, asOf: isoDate.optional() }),
    output: z.object({
      accountId: uuid,
      asOf: isoDate,
      balances: z.array(moneySchema),
      meta: resultMeta,
    }),
  },
  list_transactions: {
    description: 'Paginated transactions with filters.',
    readOnly: true,
    scopes: ['read_transactions'],
    input: z.object({
      ...scopeFilters,
      ...dateRange,
      ...page,
      categoryIds: z.array(uuid).optional(),
      search: z.string().max(200).optional(),
      minAmount: decimal.optional(),
      maxAmount: decimal.optional(),
      uncategorizedOnly: z.boolean().default(false),
    }),
    output: z.object({
      transactions: z.array(z.record(z.string(), z.unknown())),
      meta: resultMeta,
    }),
  },
  get_transaction: {
    description: 'One transaction with postings, splits and source record.',
    readOnly: true,
    scopes: ['read_transactions'],
    input: z.object({ transactionId: uuid }),
    output: z.object({ transaction: z.record(z.string(), z.unknown()), meta: resultMeta }),
  },
  get_spending_by_category: {
    description: 'Expense totals per category (splits counted, transfers excluded).',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({
      ...scopeFilters,
      ...dateRange,
      currency,
      includeSubcategories: z.boolean().default(true),
    }),
    output: z.object({ rows: z.array(amountRow), total: moneySchema, meta: resultMeta }),
  },
  get_spending_by_merchant: {
    description: 'Expense totals per merchant.',
    readOnly: true,
    scopes: ['read_aggregates', 'read_merchants'],
    input: z.object({
      ...scopeFilters,
      ...dateRange,
      currency,
      limit: z.number().int().min(1).max(200).default(25),
    }),
    output: z.object({ rows: z.array(amountRow), total: moneySchema, meta: resultMeta }),
  },
  compare_periods: {
    description: 'Compare income/expenses/categories between two periods.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({
      ...scopeFilters,
      currency,
      a: z.object({ dateFrom: isoDate, dateTo: isoDate }),
      b: z.object({ dateFrom: isoDate, dateTo: isoDate }),
      groupBy: z.enum(['category', 'merchant', 'account']).default('category'),
    }),
    output: z.object({
      rows: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          a: moneySchema,
          b: moneySchema,
          change: moneySchema,
          changePct: decimal.nullable(),
        }),
      ),
      meta: resultMeta,
    }),
  },
  get_income_summary: {
    description: 'Income totals by source/category and month.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({ ...scopeFilters, ...dateRange, currency }),
    output: z.object({ rows: z.array(amountRow), total: moneySchema, meta: resultMeta }),
  },
  get_budget_status: {
    description: 'Budget vs actual and planned for a period.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({
      profileId: uuid.optional(),
      budgetId: uuid.optional(),
      date: isoDate.optional(),
    }),
    output: z.object({
      budgets: z.array(
        z.object({
          id: uuid,
          name: z.string(),
          periodStart: isoDate,
          periodEnd: isoDate,
          limit: moneySchema,
          actual: moneySchema,
          planned: moneySchema,
          remaining: moneySchema,
        }),
      ),
      meta: resultMeta,
    }),
  },
  list_recurring_expenses: {
    description: 'Recurring expenses/subscriptions with annualized cost.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({ profileId: uuid.optional(), currency }),
    output: z.object({
      items: z.array(
        z.object({
          id: uuid,
          description: z.string(),
          amount: moneySchema,
          rrule: z.string(),
          annualized: moneySchema,
          nextDate: isoDate.nullable(),
        }),
      ),
      meta: resultMeta,
    }),
  },
  list_planned_expenses: {
    description: 'Upcoming planned expense occurrences.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({ profileId: uuid.optional(), ...dateRange, ...page }),
    output: z.object({
      items: z.array(
        z.object({
          plannedTransactionId: uuid,
          date: isoDate,
          description: z.string(),
          amount: moneySchema,
          priority: z.string(),
          confidence: z.string(),
          status: z.string(),
        }),
      ),
      meta: resultMeta,
    }),
  },
  get_cash_flow_forecast: {
    description: 'Daily projected balances with expected/conservative/optimistic scenarios.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({
      ...scopeFilters,
      currency,
      days: z.number().int().min(1).max(730).default(60),
    }),
    output: z.object({
      days: z.array(
        z.object({
          date: isoDate,
          expected: moneySchema,
          conservative: moneySchema,
          optimistic: moneySchema,
        }),
      ),
      lowest: z.object({ date: isoDate, amount: moneySchema }),
      safeToSpend: moneySchema,
      assumptions: z.array(z.string()),
      meta: resultMeta,
    }),
  },
  get_savings_goals: {
    description: 'Savings goals with progress and completion estimates.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({ profileId: uuid.optional() }),
    output: z.object({
      goals: z.array(
        z.object({
          id: uuid,
          name: z.string(),
          target: moneySchema,
          saved: moneySchema,
          estimatedCompletion: isoDate.nullable(),
        }),
      ),
      meta: resultMeta,
    }),
  },
  get_currency_exposure: {
    description: 'Holdings per currency and their value in the reporting currency.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({ ...scopeFilters, currency, asOf: isoDate.optional() }),
    output: z.object({
      rows: z.array(
        z.object({
          currency: z.string(),
          amount: moneySchema,
          converted: moneySchema.nullable(),
          rate: decimal.nullable(),
        }),
      ),
      total: moneySchema,
      meta: resultMeta,
    }),
  },
  get_import_coverage: {
    description: 'Which date ranges per account are covered by imported statements; gaps.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({ ...scopeFilters }),
    output: z.object({
      accounts: z.array(
        z.object({
          accountId: uuid,
          covered: z.array(z.object({ from: isoDate, to: isoDate })),
          gaps: z.array(z.object({ from: isoDate, to: isoDate })),
        }),
      ),
      meta: resultMeta,
    }),
  },
  get_uncategorized_transactions: {
    description: 'Transactions lacking a category (the inbox).',
    readOnly: true,
    scopes: ['read_transactions'],
    input: z.object({ ...scopeFilters, ...dateRange, ...page }),
    output: z.object({
      transactions: z.array(z.record(z.string(), z.unknown())),
      meta: resultMeta,
    }),
  },
  simulate_expense: {
    description: 'What-if: effect of a hypothetical expense on the forecast. Never writes.',
    readOnly: true,
    scopes: ['read_aggregates'],
    input: z.object({
      profileId: uuid.optional(),
      accountId: uuid.optional(),
      amount: positiveMoney,
      date: isoDate,
      recurrence: z.string().max(500).optional(),
      days: z.number().int().min(1).max(730).default(90),
    }),
    output: z.object({
      lowestBefore: moneySchema,
      lowestAfter: moneySchema,
      firstShortfallDate: isoDate.nullable(),
      safeToSpendAfter: moneySchema,
      meta: resultMeta,
    }),
  },

  // ---------- write (§29) — produce proposals unless the grant is approval:auto ----------
  update_transaction_category: {
    description: 'Set the category of a single-split transaction.',
    readOnly: false,
    scopes: ['edit_categories'],
    input: z.object({
      transactionId: uuid,
      categoryId: uuid.nullable(),
      idempotencyKey: z.string().max(200).optional(),
    }),
    output: proposal,
  },
  split_transaction: {
    description: 'Replace splits; amounts must sum exactly to the transaction amount.',
    readOnly: false,
    scopes: ['edit_splits'],
    input: z.object({
      transactionId: uuid,
      splits: z
        .array(
          z.object({
            categoryId: uuid.nullable(),
            amount: positiveMoney,
            description: z.string().max(500).default(''),
          }),
        )
        .min(1)
        .max(100),
      idempotencyKey: z.string().max(200).optional(),
    }),
    output: proposal,
  },
  bulk_categorize_transactions: {
    description: 'Set one category on many single-split transactions.',
    readOnly: false,
    scopes: ['edit_categories'],
    input: z.object({
      transactionIds: z.array(uuid).min(1).max(500),
      categoryId: uuid,
      idempotencyKey: z.string().max(200).optional(),
    }),
    output: proposal,
  },
  update_transaction_metadata: {
    description: 'Edit description, notes, tags, merchant. Never amounts or dates.',
    readOnly: false,
    scopes: ['edit_metadata'],
    input: z.object({
      transactionId: uuid,
      description: z.string().max(500).optional(),
      notes: z.string().max(5000).optional(),
      tagIds: z.array(uuid).max(50).optional(),
      merchantId: uuid.nullable().optional(),
      idempotencyKey: z.string().max(200).optional(),
    }),
    output: proposal,
  },
  create_planned_expense: {
    description: 'Create a planned (optionally recurring) expense.',
    readOnly: false,
    scopes: ['create_planned'],
    input: z.object({
      profileId: uuid.optional(),
      description: z.string().min(1).max(500),
      amount: positiveMoney,
      dueDate: isoDate,
      rrule: z.string().max(500).optional(),
      accountId: uuid.optional(),
      categoryId: uuid.optional(),
      priority: z.enum(['essential', 'high', 'normal', 'low', 'optional']).default('normal'),
      confidence: z.enum(['certain', 'expected', 'possible', 'speculative']).default('expected'),
      idempotencyKey: z.string().max(200).optional(),
    }),
    output: proposal,
  },
  update_planned_expense: {
    description: 'Update a planned expense.',
    readOnly: false,
    scopes: ['create_planned'],
    input: z.object({
      plannedTransactionId: uuid,
      description: z.string().max(500).optional(),
      amount: positiveMoney.optional(),
      dueDate: isoDate.optional(),
      status: z.enum(['active', 'paused', 'cancelled']).optional(),
      idempotencyKey: z.string().max(200).optional(),
    }),
    output: proposal,
  },
  create_budget: {
    description: 'Create a budget with category allocations.',
    readOnly: false,
    scopes: ['edit_budgets'],
    input: z.object({
      profileId: uuid.optional(),
      name: z.string().min(1).max(200),
      periodType: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
      startDate: isoDate,
      currency: z.string().length(3),
      allocations: z.array(z.object({ categoryId: uuid.nullable(), amount: moneySchema })).max(200),
      idempotencyKey: z.string().max(200).optional(),
    }),
    output: proposal,
  },
  update_budget: {
    description: 'Change budget name or allocations.',
    readOnly: false,
    scopes: ['edit_budgets'],
    input: z.object({
      budgetId: uuid,
      name: z.string().max(200).optional(),
      allocations: z
        .array(z.object({ categoryId: uuid.nullable(), amount: moneySchema }))
        .max(200)
        .optional(),
      idempotencyKey: z.string().max(200).optional(),
    }),
    output: proposal,
  },
  create_savings_goal: {
    description: 'Create a savings goal.',
    readOnly: false,
    scopes: ['edit_goals'],
    input: z.object({
      profileId: uuid.optional(),
      name: z.string().min(1).max(200),
      targetAmount: positiveMoney,
      targetDate: isoDate.optional(),
      idempotencyKey: z.string().max(200).optional(),
    }),
    output: proposal,
  },
  create_categorization_rule: {
    description: 'Create a declarative categorization rule.',
    readOnly: false,
    scopes: ['edit_rules'],
    input: z.object({
      profileId: uuid.optional(),
      name: z.string().min(1).max(200),
      match: z.object({
        field: z.enum(['description', 'payee', 'counterparty']),
        op: z.enum(['contains', 'equals', 'starts_with']),
        value: z.string().min(1).max(200),
      }),
      categoryId: uuid,
      idempotencyKey: z.string().max(200).optional(),
    }),
    output: proposal,
  },
  preview_changes: {
    description: 'Validate a batch of write-tool calls and return the preview without applying.',
    readOnly: true,
    scopes: [],
    input: z.object({
      calls: z
        .array(z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }))
        .min(1)
        .max(100),
    }),
    output: z.object({
      results: z.array(
        z.object({
          tool: z.string(),
          valid: z.boolean(),
          errors: z.array(z.string()),
          preview: z.record(z.string(), z.unknown()),
        }),
      ),
      meta: resultMeta,
    }),
  },
  apply_approved_changes: {
    description: 'Apply proposals a human already approved in the app. Cannot approve by itself.',
    readOnly: false,
    scopes: [],
    input: z.object({ proposalIds: z.array(uuid).min(1).max(100) }),
    output: z.object({
      results: z.array(
        z.object({
          proposalId: uuid,
          status: z.enum(['applied', 'not_approved', 'failed']),
          error: z.string().optional(),
        }),
      ),
      meta: resultMeta,
    }),
  },
} satisfies Record<string, ToolDef>;

export type ToolName = keyof typeof TOOLS;
export const READ_TOOLS = (Object.keys(TOOLS) as ToolName[]).filter((k) => TOOLS[k].readOnly);
export const WRITE_TOOLS = (Object.keys(TOOLS) as ToolName[]).filter((k) => !TOOLS[k].readOnly);

/** MCP tools/list payload (inputSchema as JSON Schema). */
export function toolJsonSchemas() {
  return (Object.keys(TOOLS) as ToolName[]).map((name) => ({
    name,
    description: TOOLS[name].description,
    annotations: { readOnlyHint: TOOLS[name].readOnly },
    inputSchema: z.toJSONSchema(TOOLS[name].input, { io: 'input', unrepresentable: 'any' }),
  }));
}
