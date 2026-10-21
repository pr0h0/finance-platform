// Enumerations shared by API, clients and the database CHECK constraints
// (apps/api/migrations/20261021000000_core_initial_schema.sql). Keep in sync.

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'cash',
  'wallet',
  'prepaid',
  'investment',
  'other_asset',
  'credit_card',
  'loan',
  'mortgage',
  'other_liability',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const LIABILITY_ACCOUNT_TYPES: readonly AccountType[] = [
  'credit_card',
  'loan',
  'mortgage',
  'other_liability',
];

export const TRANSACTION_KINDS = [
  'income',
  'expense',
  'transfer',
  'refund',
  'adjustment',
  'opening_balance',
  'fx',
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export const TRANSACTION_STATUSES = ['pending', 'cleared', 'reconciled', 'void'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const TRANSACTION_SOURCES = [
  'manual',
  'import',
  'recurring',
  'mcp',
  'sync',
  'bank_feed',
  'system',
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const CATEGORIZATION_SOURCES = [
  'none',
  'user',
  'rule',
  'import',
  'suggestion',
  'mcp',
] as const;
export type CategorizationSource = (typeof CATEGORIZATION_SOURCES)[number];

export const CATEGORY_KINDS = ['expense', 'income', 'transfer'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const PRIORITIES = ['essential', 'high', 'normal', 'low', 'optional'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CONFIDENCE_LEVELS = ['certain', 'expected', 'possible', 'speculative'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const PLAN_KINDS = ['income', 'expense', 'transfer'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export const PLAN_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const OCCURRENCE_STATUSES = ['pending', 'matched', 'skipped', 'paid_manual'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];
export const BUSINESS_DAY_ADJUSTMENTS = ['none', 'previous', 'next'] as const;
export type BusinessDayAdjustment = (typeof BUSINESS_DAY_ADJUSTMENTS)[number];

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'paused', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BUDGET_PERIOD_TYPES = ['weekly', 'monthly', 'quarterly', 'yearly', 'custom'] as const;
export type BudgetPeriodType = (typeof BUDGET_PERIOD_TYPES)[number];
export const ROLLOVER_POLICIES = ['none', 'carry_surplus', 'carry_deficit', 'carry_both'] as const;
export type RolloverPolicy = (typeof ROLLOVER_POLICIES)[number];

export const GOAL_KINDS = ['general', 'emergency_fund', 'purchase', 'debt_payoff'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];
export const GOAL_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const IMPORT_FORMATS = [
  'csv',
  'tsv',
  'xlsx',
  'ofx',
  'qif',
  'camt053',
  'mt940',
  'pdf',
  'json',
  'other',
] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];
export const IMPORT_BATCH_STATUSES = [
  'staged',
  'committing',
  'committed',
  'rolled_back',
  'failed',
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];
export const RECONCILIATION_OUTCOMES = [
  'new',
  'duplicate',
  'matched',
  'conflict',
  'skipped',
  'error',
] as const;
export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number];

export const PROFILE_ROLES = ['owner', 'editor', 'viewer'] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];
export const HOUSEHOLD_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type HouseholdRole = (typeof HOUSEHOLD_ROLES)[number];
export const PRIVACY_MODES = ['server_readable', 'e2ee'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export const DEVICE_PLATFORMS = [
  'web',
  'android',
  'ios',
  'macos',
  'windows',
  'linux',
  'cli',
  'other',
] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const MCP_SCOPES = [
  'read_aggregates',
  'read_transactions',
  'read_merchants',
  'read_attachments',
  'edit_categories',
  'edit_splits',
  'edit_metadata',
  'create_planned',
  'edit_budgets',
  'edit_goals',
  'edit_rules',
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export const MCP_PROPOSAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'applied',
  'failed',
  'expired',
] as const;
export type McpProposalStatus = (typeof MCP_PROPOSAL_STATUSES)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const RATE_SOURCES = ['provider', 'manual', 'fixed'] as const;
export type RateSource = (typeof RATE_SOURCES)[number];
export const CONVERSION_METHODS = ['market', 'manual', 'fixed', 'bank_actual'] as const;
export type ConversionMethod = (typeof CONVERSION_METHODS)[number];

export const SYNC_OPS = ['upsert', 'delete'] as const;
export type SyncOp = (typeof SYNC_OPS)[number];
