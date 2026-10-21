// API/wire shapes (camelCase) of the core entities. Mirrors the PostgreSQL schema; internal-only
// columns (password hashes, token hashes, server_version on child rows) are omitted.
// Conventions: Uuid = lowercase UUID string; IsoDate = "YYYY-MM-DD" local calendar date;
// IsoInstant = RFC 3339 UTC instant; Decimal = decimal string; money = Money.
import type * as E from './enums.ts';
import type { Decimal, Money } from './money.ts';

export type Uuid = string;
export type IsoDate = string;
export type IsoInstant = string;

/** Columns every synced entity carries. */
export interface Syncable {
  id: Uuid;
  profileId: Uuid;
  version: number; // optimistic-concurrency counter, +1 per accepted update
  serverVersion: number; // profile change-log position of the last change (0 = never synced)
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
  deletedAt: IsoInstant | null; // tombstone
}

export interface User {
  id: Uuid;
  email: string;
  displayName: string;
  isAdmin: boolean;
  status: 'active' | 'disabled' | 'pending';
  locale: string;
  timezone: string;
  createdAt: IsoInstant;
}

export interface Device {
  id: Uuid;
  name: string;
  platform: E.DevicePlatform;
  clientVersion: string;
  lastSeenAt: IsoInstant | null;
  lastSyncAt: IsoInstant | null;
  revokedAt: IsoInstant | null;
  createdAt: IsoInstant;
}

export interface Session {
  id: Uuid;
  deviceId: Uuid | null;
  userAgent: string;
  ip: string | null;
  createdAt: IsoInstant;
  lastSeenAt: IsoInstant;
  expiresAt: IsoInstant;
  current: boolean;
}

export interface Household {
  id: Uuid;
  name: string;
  createdBy: Uuid;
  createdAt: IsoInstant;
  members: HouseholdMember[]; // invited + active
}

export interface HouseholdMember {
  id: Uuid;
  householdId: Uuid;
  userId: Uuid | null;
  invitedEmail: string | null;
  role: E.HouseholdRole;
  status: 'invited' | 'active' | 'removed';
  joinedAt: IsoInstant | null;
}

export interface Profile {
  id: Uuid;
  name: string;
  ownerUserId: Uuid;
  householdId: Uuid | null;
  baseCurrency: string;
  timezone: string;
  locale: string;
  weekStart: number;
  privacyMode: E.PrivacyMode;
  role: E.ProfileRole; // caller's role
  syncVersion: number;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
  deletedAt: IsoInstant | null;
}

export interface Currency {
  code: string;
  name: string;
  minorUnits: number;
  symbol: string;
  isActive: boolean;
}

export interface ExchangeRate {
  id: Uuid;
  providerCode: string | null;
  profileId: Uuid | null;
  baseCurrency: string;
  quoteCurrency: string;
  rate: Decimal; // 1 base = rate quote
  rateDate: IsoDate;
  source: E.RateSource;
  fetchedAt: IsoInstant;
}

export interface Account extends Syncable {
  name: string;
  accountType: E.AccountType;
  currency: string;
  isMultiCurrency: boolean;
  institution: string;
  accountNumberMasked: string;
  openingDate: IsoDate | null;
  creditLimit: Money | null;
  includeInNetWorth: boolean;
  includeInSafeToSpend: boolean;
  isArchived: boolean;
  color: string;
  icon: string;
  sortOrder: number;
  notes: string;
  classification: 'asset' | 'liability'; // from the account type
  balances: Money[]; // current balance per currency, computed from postings (never stored)
}

export interface Category extends Syncable {
  parentId: Uuid | null;
  name: string;
  kind: E.CategoryKind;
  color: string;
  icon: string;
  sortOrder: number;
  isSystem: boolean;
  isArchived: boolean;
}

export interface Tag extends Syncable {
  name: string;
  color: string;
}

export interface Merchant extends Syncable {
  name: string;
  normalizedName: string;
  defaultCategoryId: Uuid | null;
  website: string;
  notes: string;
  aliases: string[]; // normalized alias strings used to recognise bank descriptions
}

/** One money movement on one account. Immutable once written. */
export interface Posting {
  id: Uuid;
  accountId: Uuid;
  amount: Money; // signed, settlement currency of the account
  originalAmount: Money | null; // e.g. card spend abroad
  exchangeRateId: Uuid | null;
  lineNo: number;
  memo: string;
}

/** Category allocation. amount is a positive magnitude; splits sum to |transaction amount|. */
export interface Split {
  id: Uuid;
  categoryId: Uuid | null;
  amount: Money;
  description: string;
  notes: string;
  sortOrder: number;
}

export interface Transaction extends Syncable {
  kind: E.TransactionKind;
  status: E.TransactionStatus;
  bookingDate: IsoDate;
  valueDate: IsoDate | null;
  occurredAt: IsoInstant | null;
  description: string;
  notes: string;
  merchantId: Uuid | null;
  payee: string;
  reference: string;
  excludeFromReports: boolean;
  source: E.TransactionSource;
  importRecordId: Uuid | null;
  relatedTransactionId: Uuid | null;
  correctsTransactionId: Uuid | null;
  categorizationSource: E.CategorizationSource;
  postings: Posting[];
  splits: Split[];
  tagIds: Uuid[];
  attachmentIds: Uuid[];
  conversion: Conversion | null; // fx transactions only
  sourceRecord?: ImportedRawRecord | null; // GET /transactions/{id} only: imported evidence
}

/** Rate actually applied by an fx transaction (currency_conversions). */
export interface Conversion {
  from: Money;
  to: Money;
  rate: Decimal; // to per 1 from
  rateDate: IsoDate;
  method: 'market' | 'manual' | 'fixed' | 'bank_actual';
  exchangeRateId: Uuid | null;
  fee: Money | null; // also recorded as an expense linked via relatedTransactionId
}

/** Immutable source evidence from an import. */
export interface ImportedRawRecord {
  id: Uuid;
  importBatchId: Uuid;
  accountId: Uuid | null;
  rowNumber: number;
  sourceDescription: string;
  postingDate: IsoDate;
  valueDate: IsoDate | null;
  amount: Money; // signed
  direction: 'debit' | 'credit';
  originalAmount: Money | null;
  exchangeRate: Decimal | null;
  runningBalance: Money | null;
  bankReference: string;
  statementRef: string;
  sourceAccount: string;
  counterparty: string;
  raw: Record<string, unknown>;
  dedupeFingerprint: string;
  importerId: string;
  importerVersion: string;
  warnings: string[];
  createdAt: IsoInstant;
}

export interface ImportBatch extends Syncable {
  accountId: Uuid | null;
  importerId: string;
  importerVersion: string;
  templateId: Uuid | null;
  fileName: string;
  fileSha256: string; // hex
  fileSize: number;
  status: E.ImportBatchStatus;
  coverageStart: IsoDate | null;
  coverageEnd: IsoDate | null;
  stats: Record<string, unknown>;
  error: string | null;
  committedAt: IsoInstant | null;
  rolledBackAt: IsoInstant | null;
  reprocessedFromBatchId: Uuid | null;
}

export interface ImportTemplate extends Omit<Syncable, 'profileId'> {
  profileId: Uuid | null;
  importerId: string;
  name: string;
  bankName: string;
  country: string | null;
  schemaVersion: number;
  templateVersion: string;
  format: E.ImportFormat;
  definition: Record<string, unknown>;
  isCommunity: boolean;
}

export interface Attachment extends Syncable {
  transactionId: Uuid | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  isEncrypted: boolean;
  purpose: 'receipt' | 'statement' | 'document' | 'other';
}

export interface RecurrenceSchedule extends Syncable {
  rrule: string; // RFC 5545
  startDate: IsoDate;
  endDate: IsoDate | null;
  occurrenceCount: number | null;
  timezone: string;
  businessDayAdjustment: E.BusinessDayAdjustment;
}

export interface PlannedTransaction extends Syncable {
  kind: E.PlanKind;
  accountId: Uuid | null;
  toAccountId: Uuid | null;
  categoryId: Uuid | null;
  merchantId: Uuid | null;
  description: string;
  amount: Money; // positive magnitude
  amountMin: Money | null;
  amountMax: Money | null;
  dueDate: IsoDate;
  recurrenceId: Uuid | null;
  priority: E.Priority;
  confidence: E.Confidence;
  status: E.PlanStatus;
  installmentTotal: number | null;
  installmentStart: number | null;
  reminderDaysBefore: number | null;
  notes: string;
  supersedesId: Uuid | null; // plan this one replaced (subscription price change)
}

export interface PlannedOccurrence extends Syncable {
  plannedTransactionId: Uuid;
  occurrenceDate: IsoDate;
  status: E.OccurrenceStatus;
  amountOverride: Money | null;
  dateOverride: IsoDate | null;
  matchedTransactionId: Uuid | null;
}

export interface Subscription extends Syncable {
  plannedTransactionId: Uuid | null;
  merchantId: Uuid | null;
  name: string;
  status: E.SubscriptionStatus;
  trialEndsAt: IsoDate | null;
  cancelledAt: IsoDate | null;
  url: string;
  notes: string;
}

export interface Budget extends Syncable {
  name: string;
  periodType: E.BudgetPeriodType;
  periodAnchorDay: number;
  startDate: IsoDate;
  endDate: IsoDate | null;
  currency: string;
  rolloverPolicy: E.RolloverPolicy;
  includePlanned: boolean;
  alertThresholds: Decimal[]; // fractions, e.g. ["0.8","1.0"]
  isTemplate: boolean;
  templateId: Uuid | null;
  isArchived: boolean;
}

export interface BudgetPeriod extends Syncable {
  budgetId: Uuid;
  startDate: IsoDate;
  endDate: IsoDate;
  status: 'open' | 'closed';
}

export interface BudgetAllocation extends Syncable {
  budgetId: Uuid;
  budgetPeriodId: Uuid | null;
  categoryId: Uuid | null;
  amount: Money;
  rolloverAmount: Money;
  rolloverPolicy: E.RolloverPolicy | null;
}

export interface SavingsGoal extends Syncable {
  name: string;
  kind: E.GoalKind;
  targetAmount: Money;
  startingAmount: Money;
  targetDate: IsoDate | null;
  accountId: Uuid | null;
  emergencyMonths: number | null;
  priority: E.Priority;
  status: E.GoalStatus;
  completedAt: IsoInstant | null;
  color: string;
  icon: string;
}

export interface SavingsContribution extends Syncable {
  goalId: Uuid;
  amount: Money; // negative = withdrawal
  contributionDate: IsoDate;
  transactionId: Uuid | null;
  notes: string;
}

/** A user's dismissal of an unusual-expense flag (rule = anomaly rule name). */
export interface AnomalyDismissal extends Syncable {
  transactionId: Uuid;
  rule: 'large_for_category' | 'new_merchant_large';
}

export interface CategorizationRule extends Syncable {
  name: string;
  priority: number;
  conditions: RuleCondition[];
  actions: RuleAction[];
  enabled: boolean;
  stopProcessing: boolean;
  matchCount: number;
  lastMatchedAt: IsoInstant | null;
}

/** Declarative rule language (never evaluated as code). */
export type RuleCondition =
  | {
      field: 'description' | 'payee' | 'counterparty';
      op: 'contains' | 'equals' | 'starts_with' | 'regex';
      value: string;
      caseSensitive?: boolean;
    }
  | { field: 'amount'; op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'; value: Decimal }
  | { field: 'accountId' | 'merchantId'; op: 'equals'; value: Uuid }
  | { field: 'direction'; op: 'equals'; value: 'debit' | 'credit' };
export type RuleAction =
  | { type: 'set_category'; categoryId: Uuid }
  | { type: 'set_merchant'; merchantId: Uuid }
  | { type: 'add_tag'; tagId: Uuid }
  | { type: 'set_description'; value: string }
  | { type: 'apply_split_template'; splitTemplateId: Uuid }
  | { type: 'exclude_from_reports' };

export interface Notification {
  id: Uuid;
  profileId: Uuid | null;
  kind: string;
  severity: E.NotificationSeverity;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: IsoInstant | null;
  createdAt: IsoInstant;
}

export interface McpClient {
  id: Uuid;
  name: string;
  description: string;
  tokenPrefix: string;
  enabled: boolean;
  lastUsedAt: IsoInstant | null;
  expiresAt: IsoInstant | null;
  revokedAt: IsoInstant | null;
  createdAt: IsoInstant;
}

export interface McpGrant {
  id: Uuid;
  mcpClientId: Uuid;
  profileId: Uuid;
  scope: E.McpScope;
  accountIds: Uuid[] | null;
  dateFrom: IsoDate | null;
  dateTo: IsoDate | null;
  approval: 'required' | 'auto';
}

export interface McpProposedChange {
  id: Uuid;
  profileId: Uuid;
  mcpClientId: Uuid;
  batchId: Uuid | null;
  tool: string;
  input: Record<string, unknown>;
  preview: Record<string, unknown>;
  status: E.McpProposalStatus;
  decidedBy: Uuid | null;
  decidedAt: IsoInstant | null;
  appliedAt: IsoInstant | null;
  result: Record<string, unknown> | null;
  error: string | null;
  expiresAt: IsoInstant | null;
  createdAt: IsoInstant;
}

export interface AuditEntry {
  id: number;
  occurredAt: IsoInstant;
  actorType: 'user' | 'mcp' | 'system' | 'import' | 'sync' | 'admin';
  actorId: Uuid | null;
  profileId: Uuid | null;
  action: string;
  entityType: string | null;
  entityId: Uuid | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
}

export interface EncryptedBackup {
  id: Uuid;
  profileId: Uuid | null;
  kind: 'manual' | 'scheduled' | 'pre_migration';
  formatVersion: number;
  schemaVersion: number;
  sizeBytes: number;
  sha256: string;
  /** Never key material. alg "aes-256-gcm" (server key, keyId = its fingerprint) or "none". */
  encryption: {
    alg: 'aes-256-gcm' | 'none';
    keyId?: string;
    compression: 'gzip';
    format: 'finplat-export';
  };
  status: 'in_progress' | 'complete' | 'failed' | 'expired';
  createdAt: IsoInstant;
}

/** E2EE wrapped profile data key (ADR 0005); wrappedKey is base64. */
export interface KeyEnvelope {
  id: Uuid;
  keyId: string;
  kind: 'password' | 'recovery' | 'device' | 'member';
  deviceId: Uuid | null;
  wrappedKey: string;
  kdfParams: Record<string, unknown>;
  createdAt: IsoInstant;
}

/** POST /auth/login and GET /auth/session. csrfToken for cookie sessions, token for bearer devices. */
export interface LoginResponse {
  user: User;
  csrfToken?: string;
  token?: string;
  deviceId?: Uuid;
}

export interface ProfileMember {
  userId: Uuid;
  email: string;
  role: E.ProfileRole;
}

/** GET /api/v1/meta */
export interface ServerMeta {
  name: string;
  apiVersion: string;
  schemaVersion: number;
  syncProtocolVersion: number;
  publicUrl: string;
  registrationPolicy: 'open' | 'invite_only' | 'closed' | 'first_user';
  mcpEnabled: boolean;
}

/** Error body of every non-2xx API response. */
export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}

/** Cursor-paginated list envelope. */
export interface ListResponse<T> {
  items: T[];
  nextCursor?: string;
}

/** Quick-entry template (OpenAPI TransactionTemplate). */
export interface TransactionTemplate extends Syncable {
  name: string;
  kind: 'income' | 'expense' | 'transfer';
  accountId: Uuid | null;
  toAccountId: Uuid | null;
  amount: Money | null;
  categoryId: Uuid | null;
  merchantId: Uuid | null;
  description: string;
  tagIds: Uuid[];
  sortOrder: number;
}

/** Reusable split layout: each line has a weight (proportional) or a fixed amount. */
export interface SplitTemplateLine {
  categoryId: Uuid | null;
  weight?: Decimal;
  amount?: Money;
  description: string;
}

export interface SplitTemplate extends Syncable {
  name: string;
  merchantId: Uuid | null;
  lines: SplitTemplateLine[];
}
