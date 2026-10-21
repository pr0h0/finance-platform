// Zod schemas for API inputs. Server-side Go validation is authoritative; these give clients the
// same rules (forms, local-only mode, MCP argument checks).
import * as D from '@finplat/domain';
import { currencyScale, money, splitsBalance, toMinor } from '@finplat/finance-engine';
import { z } from 'zod';

export const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'invalid uuid');

/** YYYY-MM-DD that is a real calendar date. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'invalid date');

export const isoInstant = z
  .string()
  .refine(
    (s) => !Number.isNaN(Date.parse(s)) && /T.*(Z|[+-]\d{2}:\d{2})$/.test(s),
    'expected RFC 3339 instant',
  );

export const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected decimal string');
export const positiveDecimal = decimal.refine(
  (s) => !s.startsWith('-') && /[1-9]/.test(s),
  'must be > 0',
);
export const currencyCode = z
  .string()
  .refine((c) => currencyScale(c) !== undefined, 'unknown currency');

/** Money with scale validation; output is normalized ("1.5" BAM -> "1.50"). */
export const moneySchema = z
  .object({ amount: decimal, currency: currencyCode })
  .transform((m, ctx) => {
    try {
      return money(m.amount, m.currency);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: `too many decimal places for ${m.currency}`,
        path: ['amount'],
      });
      return z.NEVER;
    }
  });
export const positiveMoney = moneySchema.refine((m) => toMinor(m) > 0n, {
  message: 'must be > 0',
  path: ['amount'],
});

const nonEmpty = z.string().trim().min(1).max(200);

export const accountCreate = z.object({
  id: uuid.optional(), // client-generated ids allowed (offline creation)
  name: nonEmpty,
  accountType: z.enum(D.ACCOUNT_TYPES),
  currency: currencyCode,
  isMultiCurrency: z.boolean().default(false),
  institution: z.string().max(200).default(''),
  openingDate: isoDate.nullable().default(null),
  openingBalance: moneySchema.optional(),
  creditLimit: moneySchema.nullable().default(null),
  includeInNetWorth: z.boolean().default(true),
  includeInSafeToSpend: z.boolean().default(true),
  color: z.string().max(32).default(''),
  icon: z.string().max(64).default(''),
  notes: z.string().max(5000).default(''),
});

export const splitInput = z.object({
  id: uuid.optional(),
  categoryId: uuid.nullable(),
  amount: positiveMoney,
  description: z.string().max(500).default(''),
  notes: z.string().max(5000).default(''),
});

/**
 * Simple-entry transaction input. The server derives postings:
 * income/expense/refund: one posting on accountId (sign from kind);
 * transfer/fx: -amount on accountId, +toAmount on toAccountId.
 */
export const transactionCreate = z
  .object({
    id: uuid.optional(),
    kind: z.enum(D.TRANSACTION_KINDS),
    accountId: uuid,
    toAccountId: uuid.optional(),
    amount: positiveMoney,
    toAmount: positiveMoney.optional(), // fx/cross-currency transfer: amount received
    bookingDate: isoDate,
    valueDate: isoDate.nullable().default(null),
    occurredAt: isoInstant.nullable().default(null),
    description: z.string().max(500).default(''),
    notes: z.string().max(5000).default(''),
    merchantId: uuid.nullable().default(null),
    payee: z.string().max(200).default(''),
    categoryId: uuid.nullable().optional(), // shorthand for a single split
    splits: z.array(splitInput).max(500).optional(),
    tagIds: z.array(uuid).max(50).default([]),
    relatedTransactionId: uuid.nullable().default(null),
    excludeFromReports: z.boolean().default(false),
    originalAmount: positiveMoney.optional(), // foreign amount of a card spend abroad
    fee: positiveMoney.optional(), // transfer/fx fee on the source account (recorded as a linked expense)
    feeCategoryId: uuid.nullable().optional(),
    reference: z.string().max(200).default(''),
    status: z.enum(['pending', 'cleared', 'void']).default('cleared'),
  })
  .superRefine((t, ctx) => {
    const twoSided = t.kind === 'transfer' || t.kind === 'fx';
    if (twoSided && !t.toAccountId)
      ctx.addIssue({ code: 'custom', path: ['toAccountId'], message: 'required for transfers' });
    if (twoSided && t.toAccountId === t.accountId)
      ctx.addIssue({
        code: 'custom',
        path: ['toAccountId'],
        message: 'must differ from accountId',
      });
    if (t.fee && !twoSided)
      ctx.addIssue({ code: 'custom', path: ['fee'], message: 'only transfers carry a fee' });
    if (t.kind === 'refund' && !t.relatedTransactionId)
      ctx.addIssue({
        code: 'custom',
        path: ['relatedTransactionId'],
        message: 'a refund must link the original transaction',
      });
    if (t.splits && t.categoryId !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['splits'],
        message: 'use either categoryId or splits',
      });
    if (
      t.splits &&
      t.splits.length > 0 &&
      !splitsBalance(
        t.amount,
        t.splits.map((s) => s.amount),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['splits'],
        message: 'splits must sum exactly to the transaction amount',
      });
    }
  });

/** POST /transactions/{id}/refunds — accountId defaults to the original's account. */
export const refundCreate = z.object({
  id: uuid.optional(),
  accountId: uuid.optional(),
  amount: positiveMoney,
  bookingDate: isoDate,
  description: z.string().max(500).default(''),
  notes: z.string().max(5000).default(''),
  payee: z.string().max(200).default(''),
  categoryId: uuid.nullable().optional(),
  splits: z.array(splitInput).max(500).optional(),
  tagIds: z.array(uuid).max(50).default([]),
});

export const merchantCreate = z.object({
  id: uuid.optional(),
  name: nonEmpty,
  defaultCategoryId: uuid.nullable().default(null),
  website: z.string().max(500).default(''),
  notes: z.string().max(5000).default(''),
  aliases: z.array(z.string().min(1).max(200)).max(50).default([]),
});

export const categoryCreate = z.object({
  id: uuid.optional(),
  parentId: uuid.nullable().default(null),
  name: nonEmpty,
  kind: z.enum(D.CATEGORY_KINDS).default('expense'),
  color: z.string().max(32).default(''),
  icon: z.string().max(64).default(''),
});

export const plannedTransactionCreate = z.object({
  id: uuid.optional(),
  kind: z.enum(D.PLAN_KINDS),
  accountId: uuid.nullable().default(null),
  toAccountId: uuid.nullable().default(null),
  categoryId: uuid.nullable().default(null),
  merchantId: uuid.nullable().default(null),
  description: z.string().max(500).default(''),
  amount: positiveMoney,
  amountMin: moneySchema.nullable().default(null),
  amountMax: moneySchema.nullable().default(null),
  dueDate: isoDate,
  recurrence: z
    .object({
      rrule: z.string().min(1).max(500),
      endDate: isoDate.nullable().default(null),
      occurrenceCount: z.number().int().positive().nullable().default(null),
      businessDayAdjustment: z.enum(D.BUSINESS_DAY_ADJUSTMENTS).default('none'),
    })
    .nullable()
    .default(null),
  priority: z.enum(D.PRIORITIES).default('normal'),
  confidence: z.enum(D.CONFIDENCE_LEVELS).default('expected'),
  installmentTotal: z.number().int().positive().nullable().default(null),
  reminderDaysBefore: z.number().int().min(0).max(60).nullable().default(null),
  notes: z.string().max(5000).default(''),
});

export const budgetCreate = z.object({
  id: uuid.optional(),
  name: nonEmpty,
  periodType: z.enum(D.BUDGET_PERIOD_TYPES),
  periodAnchorDay: z.number().int().min(1).max(31).default(1),
  startDate: isoDate,
  endDate: isoDate.nullable().default(null),
  currency: currencyCode,
  rolloverPolicy: z.enum(D.ROLLOVER_POLICIES).default('none'),
  includePlanned: z.boolean().default(true),
  alertThresholds: z.array(decimal).max(5).default(['0.8', '1.0']),
  allocations: z
    .array(z.object({ categoryId: uuid.nullable(), amount: moneySchema }))
    .max(500)
    .default([]),
});

export const savingsGoalCreate = z.object({
  id: uuid.optional(),
  name: nonEmpty,
  kind: z.enum(D.GOAL_KINDS).default('general'),
  targetAmount: positiveMoney,
  startingAmount: moneySchema.optional(),
  targetDate: isoDate.nullable().default(null),
  accountId: uuid.nullable().default(null),
  emergencyMonths: z.number().int().min(1).max(36).nullable().default(null),
  priority: z.enum(D.PRIORITIES).default('normal'),
});

export const syncOperation = z.object({
  opId: uuid,
  entityType: z.string().regex(/^[a-z_]+$/),
  entityId: uuid,
  op: z.enum(D.SYNC_OPS),
  baseVersion: z.number().int().positive().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
  changedFields: z.array(z.string()).optional(),
  clientTime: isoInstant,
});

export const pushRequest = z.object({
  protocolVersion: z.literal(D.SYNC_PROTOCOL_VERSION),
  deviceId: uuid,
  profileId: uuid,
  operations: z.array(syncOperation).min(1).max(500),
});

export { z };

// ---- auth / profiles / households (server rules: apps/api/internal/{auth,profiles,households}) ----
export const password = z.string().min(12, 'at least 12 characters').max(1024);

export const registerRequest = z.object({
  email: z.string().trim().email().max(254),
  password,
  displayName: z.string().trim().max(200).optional(),
});

export const loginRequest = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1).max(1024),
  device: z
    .object({
      name: z.string().trim().min(1).max(100),
      platform: z.enum(['web', 'android', 'ios', 'macos', 'windows', 'linux', 'cli', 'other']),
      clientVersion: z.string().max(50).optional(),
      publicKey: z.string().optional(),
    })
    .optional(),
});

export const passwordChange = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
});
export const recoverRequest = z.object({
  email: z.string().trim().email(),
  code: z.string().min(1),
  newPassword: password,
});

export const profileInput = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(100),
  householdId: uuid.optional(),
  baseCurrency: currencyCode.optional(),
  timezone: z.string().min(1).optional(),
  locale: z.string().min(2).max(35).optional(),
  weekStart: z.number().int().min(0).max(6).optional(),
  privacyMode: z.enum(['server_readable', 'e2ee']).optional(),
});

export const householdInvite = z.object({
  email: z.string().trim().email(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']).default('member'),
});
