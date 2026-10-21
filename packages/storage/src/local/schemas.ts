// Input schemas for entities that @finplat/validation does not (yet) cover. Shapes follow the
// OpenAPI *Input schemas (docs/api/openapi.yaml); move them to @finplat/validation when the
// owning API module adds them there.
import * as D from '@finplat/domain';
import {
  decimal,
  isoDate,
  isoInstant,
  moneySchema,
  positiveMoney,
  splitInput,
  uuid,
  z,
} from '@finplat/validation';

const name = z.string().trim().min(1).max(200);

export const tagInput = z.object({
  id: uuid.optional(),
  name,
  color: z.string().max(32).default(''),
});

export const transactionTemplateInput = z.object({
  id: uuid.optional(),
  name,
  kind: z.enum(['income', 'expense', 'transfer']),
  accountId: uuid.nullable().default(null),
  toAccountId: uuid.nullable().default(null),
  amount: positiveMoney.nullable().default(null),
  categoryId: uuid.nullable().default(null),
  merchantId: uuid.nullable().default(null),
  description: z.string().max(500).default(''),
  tagIds: z.array(uuid).max(50).default([]),
  sortOrder: z.number().int().default(0),
});

export const splitTemplateLine = z
  .object({
    categoryId: uuid.nullable(),
    weight: decimal.optional(),
    amount: positiveMoney.optional(),
    description: z.string().max(500).default(''),
  })
  .refine((l) => (l.weight === undefined) !== (l.amount === undefined), {
    message: 'each line needs exactly one of weight or amount',
  });

export const splitTemplateInput = z.object({
  id: uuid.optional(),
  name,
  merchantId: uuid.nullable().default(null),
  lines: z.array(splitTemplateLine).min(1).max(500),
});

const ruleCondition = z.union([
  z.object({
    field: z.enum(['description', 'payee', 'counterparty']),
    op: z.enum(['contains', 'equals', 'starts_with', 'regex']),
    value: z.string().min(1).max(256),
    caseSensitive: z.boolean().optional(),
  }),
  z.object({
    field: z.literal('amount'),
    op: z.enum(['eq', 'lt', 'lte', 'gt', 'gte']),
    value: decimal,
  }),
  z.object({ field: z.enum(['accountId', 'merchantId']), op: z.literal('equals'), value: uuid }),
  z.object({
    field: z.literal('direction'),
    op: z.literal('equals'),
    value: z.enum(['debit', 'credit']),
  }),
]);
const ruleAction = z.union([
  z.object({ type: z.literal('set_category'), categoryId: uuid }),
  z.object({ type: z.literal('set_merchant'), merchantId: uuid }),
  z.object({ type: z.literal('add_tag'), tagId: uuid }),
  z.object({ type: z.literal('set_description'), value: z.string().max(500) }),
  z.object({ type: z.literal('apply_split_template'), splitTemplateId: uuid }),
  z.object({ type: z.literal('exclude_from_reports') }),
]);

export const ruleInput = z.object({
  id: uuid.optional(),
  name,
  priority: z.number().int().default(100),
  conditions: z.array(ruleCondition).min(1).max(20),
  actions: z.array(ruleAction).min(1).max(20),
  enabled: z.boolean().default(true),
  stopProcessing: z.boolean().default(false),
});

export const recurrenceInput = z.object({
  id: uuid.optional(),
  rrule: z.string().min(1).max(500),
  startDate: isoDate,
  endDate: isoDate.nullable().default(null),
  occurrenceCount: z.number().int().positive().nullable().default(null),
  timezone: z.string().max(64).default('UTC'),
  businessDayAdjustment: z.enum(D.BUSINESS_DAY_ADJUSTMENTS).default('none'),
});

export const subscriptionInput = z.object({
  id: uuid.optional(),
  plannedTransactionId: uuid.nullable().default(null),
  merchantId: uuid.nullable().default(null),
  name,
  status: z.enum(D.SUBSCRIPTION_STATUSES).default('active'),
  trialEndsAt: isoDate.nullable().default(null),
  cancelledAt: isoDate.nullable().default(null),
  url: z.string().max(500).default(''),
  notes: z.string().max(5000).default(''),
});

export const contributionInput = z.object({
  id: uuid.optional(),
  goalId: uuid,
  amount: moneySchema, // negative = withdrawal
  contributionDate: isoDate,
  transactionId: uuid.nullable().default(null),
  notes: z.string().max(5000).default(''),
});

export const exchangeRateInput = z.object({
  id: uuid.optional(),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  quoteCurrency: z.string().regex(/^[A-Z]{3}$/),
  rate: decimal,
  rateDate: isoDate,
});

export const transactionPatch = z
  .object({
    version: z.number().int().positive(),
    description: z.string().max(500),
    notes: z.string().max(5000),
    merchantId: uuid.nullable(),
    payee: z.string().max(200),
    reference: z.string().max(200),
    bookingDate: isoDate,
    valueDate: isoDate.nullable(),
    occurredAt: isoInstant.nullable(),
    amount: moneySchema,
    toAmount: positiveMoney,
    status: z.enum(['pending', 'cleared', 'void']),
    excludeFromReports: z.boolean(),
    tagIds: z.array(uuid).max(50),
    categoryId: uuid.nullable(),
  })
  .partial()
  .required({ version: true })
  .strict();

export const splitsReplace = z
  .object({
    version: z.number().int().positive(),
    splits: z.array(splitInput).max(500).optional(),
    splitTemplateId: uuid.optional(),
  })
  .strict()
  .refine((s) => (s.splits === undefined) !== (s.splitTemplateId === undefined), {
    message: 'send either splits or splitTemplateId',
  });

export const adjustmentInput = z
  .object({
    amount: moneySchema, // signed correction
    bookingDate: isoDate,
    reason: z.string().min(1).max(500),
    accountId: uuid.optional(),
  })
  .strict();

export const bulkEdit = z
  .object({
    transactionIds: z.array(uuid).min(1).max(1000),
    set: z
      .object({
        categoryId: uuid.nullable(),
        merchantId: uuid.nullable(),
        addTagIds: z.array(uuid),
        removeTagIds: z.array(uuid),
        excludeFromReports: z.boolean(),
        status: z.enum(['pending', 'cleared', 'void']),
        clearCategory: z.boolean(),
        clearMerchant: z.boolean(),
      })
      .partial()
      .strict(),
  })
  .strict();

export const profileInput = z.object({
  id: uuid.optional(),
  name,
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().max(64).default('UTC'),
  locale: z.string().max(35).default('en'),
  weekStart: z.number().int().min(1).max(7).default(1),
});
