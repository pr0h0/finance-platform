// LocalFinanceService: the REST API's operations implemented on a LocalStore (local-only mode and
// the offline cache of connected mode). Every mutation of a synced entity is written together with
// an outbox op (sync-protocol.md) in the same store transaction. Calculations use
// @finplat/finance-engine, never floats.
import type * as D from '@finplat/domain';
import {
  type AccountBalance,
  accountBalances,
  add,
  addMonths,
  allocate,
  type BudgetStatus,
  budgetStatus,
  compare,
  compareDecimal,
  createRateBook,
  evaluateRules,
  fromMinor,
  type LedgerTransaction,
  negate,
  type PlanOccurrence,
  planOccurrences,
  type RateSnapshot,
  reportingConverter,
  sum,
  toMinor,
} from '@finplat/finance-engine';
import {
  accountCreate,
  budgetCreate,
  categoryCreate,
  merchantCreate,
  plannedTransactionCreate,
  refundCreate,
  savingsGoalCreate,
  transactionCreate,
  type z,
} from '@finplat/validation';
import { uuidv7 } from '../ids.ts';
import type { LocalStore, Query, StoreTx } from '../types.ts';
import { conflict, invalid, notFound, parse, type ServiceError, unprocessable } from './errors.ts';
import {
  abs,
  applySplitTemplate,
  buildSplits,
  buildTransfer,
  posting,
  SPLIT_KINDS,
  type SplitIn,
} from './ledger.ts';
import * as S from './schemas.ts';

/** Synced entity tables handled by the generic CRUD (transactions have their own methods). */
export interface EntityMap {
  accounts: D.Account;
  categories: D.Category;
  tags: D.Tag;
  merchants: D.Merchant;
  transaction_templates: D.TransactionTemplate;
  split_templates: D.SplitTemplate;
  categorization_rules: D.CategorizationRule;
  budgets: D.Budget;
  recurrence_schedules: D.RecurrenceSchedule;
  planned_transactions: D.PlannedTransaction;
  subscriptions: D.Subscription;
  savings_goals: D.SavingsGoal;
  savings_contributions: D.SavingsContribution;
}
export type EntityName = keyof EntityMap;

export interface InputMap {
  accounts: z.input<typeof accountCreate>;
  categories: z.input<typeof categoryCreate>;
  tags: z.input<typeof S.tagInput>;
  merchants: z.input<typeof merchantCreate>;
  transaction_templates: z.input<typeof S.transactionTemplateInput>;
  split_templates: z.input<typeof S.splitTemplateInput>;
  categorization_rules: z.input<typeof S.ruleInput>;
  budgets: z.input<typeof budgetCreate>;
  recurrence_schedules: z.input<typeof S.recurrenceInput>;
  planned_transactions: z.input<typeof plannedTransactionCreate>;
  subscriptions: z.input<typeof S.subscriptionInput>;
  savings_goals: z.input<typeof savingsGoalCreate>;
  savings_contributions: z.input<typeof S.contributionInput>;
}
export type Patch<E extends EntityName> = Partial<InputMap[E]> & { version?: number };

export type TransactionInput = z.input<typeof transactionCreate>;
export type RefundInput = z.input<typeof refundCreate>;
export type TransactionPatch = z.input<typeof S.transactionPatch>;
export type SplitsReplace = z.input<typeof S.splitsReplace>;
export type AdjustmentInput = z.input<typeof S.adjustmentInput>;
export type BulkEdit = z.input<typeof S.bulkEdit>;

export interface TransactionFilter {
  from?: string;
  to?: string;
  accountIds?: string[];
  categoryId?: string;
  merchantId?: string;
  tagId?: string;
  kind?: string;
  q?: string;
  minAmount?: string;
  maxAmount?: string;
  uncategorized?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** Normalized record as produced by @finplat/importer-sdk (structural subset). */
export interface StageRecord {
  rowNumber: number;
  postingDate: string;
  valueDate?: string;
  description: string;
  direction: 'debit' | 'credit';
  amount: string; // positive magnitude
  currency: string;
  originalAmount?: string;
  originalCurrency?: string;
  exchangeRate?: string;
  runningBalance?: string;
  bankReference?: string;
  statementRef?: string;
  accountRef?: string;
  counterparty?: string;
  raw: Record<string, string>;
  fingerprint: string;
  warnings?: { message: string }[];
}

export interface StageImportInput {
  accountId: string;
  importerId: string;
  importerVersion: string;
  fileName: string;
  fileSha256: string;
  fileSize: number;
  records: StageRecord[];
  /** Original file + parsed statements: kept on the device so a connected client can upload the
   * batch as immutable evidence (sync-client uploads it with POST /imports). */
  source?: Blob;
  statements?: unknown[];
}

/** blobs row holding an import's original file (see StageImportInput.source). */
export const importSourceKey = (batchId: string) => `import:${batchId}`;

export interface StagedRow {
  record: D.ImportedRawRecord;
  outcome: 'new' | 'duplicate';
  duplicateOf: string | null; // raw record id already imported with the same fingerprint
}

export interface ImportPreview {
  batch: D.ImportBatch;
  rows: StagedRow[];
  totals: { income: D.Money; expenses: D.Money; count: number; duplicates: number };
}

export interface CommitRow {
  rawRecordId: string;
  selected?: boolean;
  categoryId?: string | null;
  description?: string;
}

export interface LocalAttachmentInput {
  file: Blob;
  fileName: string;
  contentType?: string;
  transactionId?: string | null;
  purpose?: D.Attachment['purpose'];
}

export interface ServiceOptions {
  now?: () => Date;
  newId?: () => string;
  /** Called after every committed write (connected mode schedules a sync push). */
  onWrite?: () => void;
  /** Connected mode: fetch attachment content that is not on this device (uploaded elsewhere). */
  fetchAttachment?: (id: string) => Promise<Blob>;
}

const LIABILITIES = new Set(['credit_card', 'loan', 'mortgage', 'other_liability']);

/** Fields never auto-merged by sync (sync-protocol.md "money-bearing"). Sent as changedFields. */
const READONLY_FIELDS = new Set([
  'id',
  'profileId',
  'version',
  'serverVersion',
  'createdAt',
  'updatedAt',
  'deletedAt',
]);

type Syncable = D.Syncable & Record<string, unknown>;

/** Entity tables whose rows are local outbox-tracked (all synced tables). */
const ALL_TABLES = [
  'accounts',
  'categories',
  'tags',
  'merchants',
  'transactions',
  'transaction_templates',
  'split_templates',
  'categorization_rules',
  'budgets',
  'budget_allocations',
  'recurrence_schedules',
  'planned_transactions',
  'planned_occurrences',
  'subscriptions',
  'savings_goals',
  'savings_contributions',
  'import_batches',
  'imported_raw_records',
  'attachments',
  'blobs',
  'exchange_rates',
  'settings',
  'notifications',
];

export class LocalFinanceService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly onWrite: () => void;
  private readonly fetchAttachment?: (id: string) => Promise<Blob>;

  constructor(
    readonly store: LocalStore,
    readonly profileId: string,
    opts: ServiceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => uuidv7());
    this.onWrite = opts.onWrite ?? (() => undefined);
    this.fetchAttachment = opts.fetchAttachment;
  }

  // ------------------------------------------------------------ plumbing

  private ts = () => this.now().toISOString();
  private today = () => this.ts().slice(0, 10);

  /** One readwrite transaction over every entity table (simple and always correct scope). */
  private async write<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const r = await this.store.run('readwrite', ALL_TABLES, fn);
    this.onWrite();
    return r;
  }

  private read<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.store.run('readonly', ALL_TABLES, fn);
  }

  private async load<T extends Syncable>(tx: StoreTx, table: string, id: string, what = table) {
    const row = await tx.get<T>(table, id);
    if (!row || row.profileId !== this.profileId || row.deletedAt) throw notFound(what);
    return row;
  }

  /** Insert a new synced row + outbox create op. */
  private async insert<T extends Syncable>(
    tx: StoreTx,
    table: string,
    fields: Omit<T, keyof D.Syncable> & { id?: string },
  ): Promise<T> {
    const id = fields.id ?? this.newId();
    if (await tx.get(table, id))
      throw conflict('an entity with this id already exists', 'id_conflict');
    const t = this.ts();
    const row = {
      ...fields,
      id,
      profileId: this.profileId,
      version: 1,
      serverVersion: 0,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
    } as unknown as T;
    await tx.put(table, row);
    await this.op(tx, table, row, null, undefined);
    return row;
  }

  /** Update a synced row (version + 1) + outbox update op with the changed fields. */
  private async replace<T extends Syncable>(tx: StoreTx, table: string, prev: T, next: T) {
    const changed = Object.keys(next).filter(
      (k) => !READONLY_FIELDS.has(k) && JSON.stringify(next[k]) !== JSON.stringify(prev[k]),
    );
    if (changed.length === 0) return prev;
    const row = { ...next, version: prev.version + 1, updatedAt: this.ts() } as T;
    await tx.put(table, row);
    await this.op(tx, table, row, prev.version, changed);
    return row;
  }

  /** Tombstone a synced row + outbox delete op. */
  private async tombstone<T extends Syncable>(tx: StoreTx, table: string, prev: T) {
    const t = this.ts();
    await tx.put(table, { ...prev, deletedAt: t, updatedAt: t, version: prev.version + 1 });
    await tx.enqueue({
      opId: this.newId(),
      profileId: this.profileId,
      entityType: table,
      entityId: prev.id,
      op: 'delete',
      baseVersion: prev.version,
      data: null,
      clientTime: t,
    });
  }

  private async op(
    tx: StoreTx,
    table: string,
    row: Syncable,
    baseVersion: number | null,
    changedFields: string[] | undefined,
  ) {
    await tx.enqueue({
      opId: this.newId(),
      profileId: this.profileId,
      entityType: table,
      entityId: row.id,
      op: 'upsert',
      baseVersion,
      data: row as Record<string, unknown>,
      ...(changedFields ? { changedFields } : {}),
      clientTime: this.ts(),
    });
  }

  private checkVersion(row: D.Syncable, version: number | undefined) {
    if (version !== undefined && version !== row.version)
      throw conflict(`entity was modified (version ${row.version}, sent ${version})`, 'conflict', {
        currentVersion: row.version,
      });
  }

  private async exists(tx: StoreTx, table: string, id: string | null | undefined, field: string) {
    if (!id) return;
    const r = await tx.get<D.Syncable>(table, id);
    if (!r || r.profileId !== this.profileId || r.deletedAt)
      throw invalid({ [field]: 'unknown id' });
  }

  private all<T>(tx: StoreTx, table: string, q: Omit<Query<T>, 'profileId'> = {}) {
    return tx.query<T>(table, { ...q, profileId: this.profileId });
  }

  // ------------------------------------------------------------ generic entities

  async list<E extends EntityName>(
    entity: E,
    q: { includeDeleted?: boolean } = {},
  ): Promise<EntityMap[E][]> {
    return this.read(async (tx) => {
      const rows = await this.all<EntityMap[E]>(tx, entity, q);
      return entity === 'accounts'
        ? ((await this.withBalances(tx, rows as D.Account[])) as EntityMap[E][])
        : rows;
    });
  }

  async get<E extends EntityName>(entity: E, id: string): Promise<EntityMap[E]> {
    return this.read(async (tx) => {
      const row = await this.load<EntityMap[E] & Syncable>(tx, entity, id);
      return entity === 'accounts'
        ? ((await this.withBalances(tx, [row as unknown as D.Account]))[0] as EntityMap[E])
        : row;
    });
  }

  async create<E extends EntityName>(entity: E, input: InputMap[E]): Promise<EntityMap[E]> {
    const row = await this.write(async (tx) => {
      const fields = await this.build(tx, entity, input, undefined);
      const created = await this.insert<Syncable>(tx, entity, fields as never);
      await this.afterCreate(tx, entity, created, input);
      return created;
    });
    return this.get(entity, row.id);
  }

  async update<E extends EntityName>(
    entity: E,
    id: string,
    patch: Patch<E>,
  ): Promise<EntityMap[E]> {
    await this.write(async (tx) => {
      const prev = await this.load<Syncable>(tx, entity, id);
      const { version, ...rest } = patch as Record<string, unknown>;
      this.checkVersion(prev, version as number | undefined);
      const merged = { ...prev, ...rest };
      const fields = await this.build(tx, entity, merged as unknown as InputMap[E], prev);
      const next = await this.replace(tx, entity, prev, { ...prev, ...fields, id } as Syncable);
      await this.afterUpdate(tx, entity, next, rest);
    });
    return this.get(entity, id);
  }

  async remove(entity: EntityName, id: string, version?: number): Promise<void> {
    await this.write(async (tx) => {
      const prev = await this.load<Syncable>(tx, entity, id);
      this.checkVersion(prev, version);
      if (entity === 'accounts') {
        const used = await this.all<D.Transaction>(tx, 'transactions', {
          limit: 1,
          filter: (t) => t.postings.some((p) => p.accountId === id),
        });
        if (used.length)
          throw conflict('account has transactions; archive it instead', 'account_in_use');
      }
      if (entity === 'categories') {
        const kids = await this.all<D.Category>(tx, 'categories', {
          index: 'parentId',
          from: id,
          to: id,
          limit: 1,
        });
        if (kids.length) throw conflict('category has subcategories', 'category_in_use');
      }
      if (entity === 'budgets')
        for (const a of await this.all<Syncable>(tx, 'budget_allocations', {
          index: 'budgetId',
          from: id,
          to: id,
        }))
          await this.tombstone(tx, 'budget_allocations', a);
      await this.tombstone(tx, entity, prev);
    });
  }

  /** Validate input (create, or merged entity on update) and return the stored fields. */
  private async build<E extends EntityName>(
    tx: StoreTx,
    entity: E,
    input: InputMap[E],
    prev: Syncable | undefined,
  ): Promise<Record<string, unknown>> {
    const p = <Sc extends z.ZodType>(sc: Sc) =>
      parse(sc, input) as Record<string, unknown> & z.output<Sc>;
    switch (entity) {
      case 'accounts': {
        const a = p(accountCreate);
        if (prev && prev.currency !== a.currency)
          throw invalid({ currency: 'the account currency cannot change' });
        const { openingBalance: _ob, ...rest } = a;
        return {
          ...rest,
          accountNumberMasked:
            (input as { accountNumberMasked?: string }).accountNumberMasked ?? '',
          isArchived: (input as { isArchived?: boolean }).isArchived ?? false,
          sortOrder: (input as { sortOrder?: number }).sortOrder ?? 0,
        };
      }
      case 'categories': {
        const c = p(categoryCreate);
        if (c.parentId) {
          if (prev && c.parentId === prev.id)
            throw invalid({ parentId: 'cannot be its own parent' });
          await this.exists(tx, 'categories', c.parentId, 'parentId');
        }
        return {
          ...c,
          sortOrder: (input as { sortOrder?: number }).sortOrder ?? 0,
          isSystem: false,
          isArchived: (input as { isArchived?: boolean }).isArchived ?? false,
        };
      }
      case 'tags':
        return p(S.tagInput);
      case 'merchants': {
        const m = p(merchantCreate);
        await this.exists(tx, 'categories', m.defaultCategoryId, 'defaultCategoryId');
        return { ...m, normalizedName: m.name.trim().toLowerCase().replace(/\s+/g, ' ') };
      }
      case 'transaction_templates': {
        const t = p(S.transactionTemplateInput);
        await this.exists(tx, 'accounts', t.accountId, 'accountId');
        await this.exists(tx, 'accounts', t.toAccountId, 'toAccountId');
        await this.exists(tx, 'categories', t.categoryId, 'categoryId');
        return t;
      }
      case 'split_templates':
        return p(S.splitTemplateInput);
      case 'categorization_rules':
        return {
          ...p(S.ruleInput),
          matchCount: (prev?.matchCount as number) ?? 0,
          lastMatchedAt: (prev?.lastMatchedAt as string | null) ?? null,
        };
      case 'budgets': {
        const { allocations: _a, ...b } = p(budgetCreate);
        return {
          ...b,
          isTemplate: (input as { isTemplate?: boolean }).isTemplate ?? false,
          templateId: (input as { templateId?: string | null }).templateId ?? null,
          isArchived: (input as { isArchived?: boolean }).isArchived ?? false,
        };
      }
      case 'recurrence_schedules':
        return p(S.recurrenceInput);
      case 'planned_transactions': {
        const pl = p(plannedTransactionCreate);
        await this.exists(tx, 'accounts', pl.accountId, 'accountId');
        await this.exists(tx, 'accounts', pl.toAccountId, 'toAccountId');
        await this.exists(tx, 'categories', pl.categoryId, 'categoryId');
        const { recurrence: _r, ...rest } = pl;
        return {
          ...rest,
          recurrenceId: (prev?.recurrenceId as string | null) ?? null,
          status: (input as { status?: string }).status ?? 'active',
          installmentStart:
            (input as { installmentStart?: number | null }).installmentStart ?? null,
        };
      }
      case 'subscriptions':
        return p(S.subscriptionInput);
      case 'savings_goals': {
        const g = p(savingsGoalCreate);
        return {
          ...g,
          startingAmount: g.startingAmount ?? fromMinor(0n, g.targetAmount.currency),
          status: (input as { status?: string }).status ?? 'active',
          completedAt: (input as { completedAt?: string | null }).completedAt ?? null,
          color: (input as { color?: string }).color ?? '',
          icon: (input as { icon?: string }).icon ?? '',
        };
      }
      case 'savings_contributions': {
        const c = p(S.contributionInput);
        await this.exists(tx, 'savings_goals', c.goalId, 'goalId');
        await this.exists(tx, 'transactions', c.transactionId, 'transactionId');
        return c;
      }
    }
    throw new Error(`unknown entity ${entity}`);
  }

  private async afterCreate(tx: StoreTx, entity: EntityName, row: Syncable, input: unknown) {
    if (entity === 'accounts') {
      const ob = (input as { openingBalance?: D.Money }).openingBalance;
      if (ob && toMinor(ob) !== 0n)
        await this.insertTransaction(tx, {
          kind: 'opening_balance',
          bookingDate: (row.openingDate as string | null) ?? this.today(),
          description: 'Opening balance',
          postings: [posting(this.newId, row.id, ob, 0, { memo: 'opening balance' })],
          splits: [],
        });
    }
    if (entity === 'budgets') await this.writeAllocations(tx, row.id, input);
    if (entity === 'planned_transactions') await this.writeRecurrence(tx, row, input);
  }

  private async afterUpdate(
    tx: StoreTx,
    entity: EntityName,
    row: Syncable,
    patch: Record<string, unknown>,
  ) {
    if (entity === 'budgets' && 'allocations' in patch) {
      for (const a of await this.all<Syncable>(tx, 'budget_allocations', {
        index: 'budgetId',
        from: row.id,
        to: row.id,
      }))
        if (!a.budgetPeriodId) await this.tombstone(tx, 'budget_allocations', a); // period rows are server-managed
      await this.writeAllocations(tx, row.id, patch);
    }
    if (entity === 'planned_transactions' && 'recurrence' in patch)
      await this.writeRecurrence(tx, row, patch);
  }

  private async writeAllocations(tx: StoreTx, budgetId: string, input: unknown) {
    const allocs =
      (input as { allocations?: { categoryId: string | null; amount: D.Money }[] }).allocations ??
      [];
    for (const a of allocs) {
      await this.exists(tx, 'categories', a.categoryId, 'allocations.categoryId');
      await this.insert(tx, 'budget_allocations', {
        budgetId,
        budgetPeriodId: null,
        categoryId: a.categoryId,
        amount: a.amount,
        rolloverAmount: fromMinor(0n, a.amount.currency),
        rolloverPolicy: null,
      });
    }
  }

  private async writeRecurrence(tx: StoreTx, plan: Syncable, input: unknown) {
    const rec = (input as { recurrence?: z.input<typeof S.recurrenceInput> | null }).recurrence;
    const prevId = plan.recurrenceId as string | null;
    let recurrenceId: string | null = null;
    if (rec) {
      const r = parse(S.recurrenceInput, { ...rec, startDate: rec.startDate ?? plan.dueDate });
      if (prevId) {
        const prev = await this.load<Syncable>(tx, 'recurrence_schedules', prevId);
        await this.replace(tx, 'recurrence_schedules', prev, { ...prev, ...r, id: prevId });
        recurrenceId = prevId;
      } else recurrenceId = (await this.insert<Syncable>(tx, 'recurrence_schedules', r)).id;
    } else if (prevId) {
      const prev = await tx.get<Syncable>('recurrence_schedules', prevId);
      if (prev && !prev.deletedAt) await this.tombstone(tx, 'recurrence_schedules', prev);
    }
    if (recurrenceId !== prevId) {
      const cur = (await tx.get<Syncable>('planned_transactions', plan.id)) as Syncable;
      await this.replace(tx, 'planned_transactions', cur, { ...cur, recurrenceId });
    }
  }

  private async withBalances(tx: StoreTx, accounts: D.Account[]): Promise<D.Account[]> {
    const bal = accountBalances(await this.all<D.Transaction>(tx, 'transactions'));
    return accounts.map((a) => ({
      ...a,
      classification: LIABILITIES.has(a.accountType) ? 'liability' : 'asset',
      balances: bal
        .filter((b) => b.accountId === a.id)
        .map((b) => ({ amount: b.amount, currency: b.currency })),
    }));
  }

  // ------------------------------------------------------------ transactions

  private async insertTransaction(
    tx: StoreTx,
    t: Partial<D.Transaction> & Pick<D.Transaction, 'kind' | 'bookingDate' | 'postings' | 'splits'>,
  ): Promise<D.Transaction> {
    return this.insert<D.Transaction & Syncable>(tx, 'transactions', {
      status: 'cleared',
      valueDate: null,
      occurredAt: null,
      description: '',
      notes: '',
      merchantId: null,
      payee: '',
      reference: '',
      excludeFromReports: false,
      source: 'manual',
      importRecordId: null,
      relatedTransactionId: null,
      correctsTransactionId: null,
      categorizationSource: 'none',
      tagIds: [],
      attachmentIds: [],
      conversion: null,
      ...t,
    } as never);
  }

  private async account(tx: StoreTx, id: string, field: string): Promise<D.Account> {
    const a = await tx.get<D.Account>('accounts', id);
    if (!a || a.profileId !== this.profileId || a.deletedAt)
      throw invalid({ [field]: 'unknown account' });
    return a;
  }

  private checkCurrency(a: D.Account, m: D.Money, field: string) {
    if (!a.isMultiCurrency && a.currency !== m.currency)
      throw invalid({ [field]: `account ${a.name} holds ${a.currency}` });
  }

  private async rates(tx: StoreTx): Promise<RateSnapshot[]> {
    return (await this.all<D.ExchangeRate>(tx, 'exchange_rates')).map((r) => ({
      baseCurrency: r.baseCurrency,
      quoteCurrency: r.quoteCurrency,
      rate: r.rate,
      rateDate: r.rateDate,
      source: r.source,
    }));
  }

  /** Same validation and posting derivation as POST /transactions. */
  async createTransaction(input: TransactionInput, source: D.TransactionSource = 'manual') {
    const id = await this.write((tx) => this.createTx(tx, input, source));
    return this.getTransaction(id);
  }

  private async createTx(tx: StoreTx, input: TransactionInput, source: D.TransactionSource) {
    const v = parse(transactionCreate, input);
    const src = await this.account(tx, v.accountId, 'accountId');
    this.checkCurrency(src, v.amount, 'amount');
    if (v.tagIds.length) for (const t of v.tagIds) await this.exists(tx, 'tags', t, 'tagIds');
    await this.exists(tx, 'merchants', v.merchantId, 'merchantId');
    if ((v.categoryId || v.splits?.length) && !SPLIT_KINDS.has(v.kind))
      throw invalid({ splits: `${v.kind} transactions are not categorized` });
    if (v.categoryId) await this.exists(tx, 'categories', v.categoryId, 'categoryId');
    for (const s of v.splits ?? [])
      await this.exists(tx, 'categories', s.categoryId, 'splits.categoryId');

    const base: Partial<D.Transaction> = {
      id: v.id,
      status: v.status,
      valueDate: v.valueDate,
      occurredAt: v.occurredAt,
      description: v.description,
      notes: v.notes,
      merchantId: v.merchantId,
      payee: v.payee,
      reference: v.reference,
      excludeFromReports: v.excludeFromReports,
      source,
      tagIds: v.tagIds,
      relatedTransactionId: v.relatedTransactionId,
      categorizationSource: v.categoryId || v.splits?.length ? 'user' : 'none',
    };
    const orig = v.originalAmount
      ? (() => {
          if (v.originalAmount.currency === v.amount.currency)
            throw invalid({ originalAmount: 'must be a positive amount in another currency' });
          return v.originalAmount;
        })()
      : null;

    switch (v.kind) {
      case 'expense':
      case 'income': {
        await this.exists(tx, 'transactions', v.relatedTransactionId, 'relatedTransactionId');
        const t = await this.insertTransaction(tx, {
          ...base,
          kind: v.kind,
          bookingDate: v.bookingDate,
          postings: [
            posting(this.newId, src.id, v.kind === 'expense' ? negate(v.amount) : v.amount, 0, {
              originalAmount: orig,
            }),
          ],
          splits: buildSplits(this.newId, v.splits, v.categoryId, v.amount),
        });
        // rules run on every new uncategorized entry, as on the server (automation.ApplyRules)
        if (base.categorizationSource === 'none') {
          const rules = await this.all<D.CategorizationRule>(tx, 'categorization_rules');
          const o = await this.ruleOutcome(tx, t as D.Transaction & Syncable, rules);
          if (o) await this.replace(tx, 'transactions', t as D.Transaction & Syncable, o.next);
        }
        return t.id;
      }
      case 'refund': {
        const splits = await this.refundSplits(
          tx,
          v.relatedTransactionId as string,
          v.amount,
          v,
          v.id,
        );
        const t = await this.insertTransaction(tx, {
          ...base,
          kind: 'refund',
          bookingDate: v.bookingDate,
          postings: [posting(this.newId, src.id, v.amount, 0, { originalAmount: orig })],
          splits,
        });
        return t.id;
      }
      case 'transfer':
      case 'fx': {
        const dst = await this.account(tx, v.toAccountId as string, 'toAccountId');
        if (v.toAmount) this.checkCurrency(dst, v.toAmount, 'toAmount');
        const r = buildTransfer(
          this.newId,
          src,
          dst,
          v.amount,
          v.toAmount,
          v.kind,
          v.bookingDate,
          await this.rates(tx),
          v.fee,
        );
        const t = await this.insertTransaction(tx, {
          ...base,
          kind: r.kind,
          bookingDate: v.bookingDate,
          postings: r.postings,
          splits: [],
          conversion: r.conversion,
        });
        if (v.fee) {
          if (v.fee.currency !== v.amount.currency)
            throw invalid({ fee: 'fee is charged on the source account' });
          await this.exists(tx, 'categories', v.feeCategoryId, 'feeCategoryId');
          await this.insertTransaction(tx, {
            kind: 'expense',
            status: t.status,
            bookingDate: t.bookingDate,
            description: `Fee: ${t.description || 'transfer'}`,
            source,
            relatedTransactionId: t.id,
            postings: [posting(this.newId, src.id, negate(v.fee), 0, { memo: 'fee' })],
            splits: buildSplits(this.newId, undefined, v.feeCategoryId ?? null, v.fee),
          });
        }
        return t.id;
      }
      case 'opening_balance': {
        const dup = await this.all<D.Transaction>(tx, 'transactions', {
          limit: 1,
          filter: (t) =>
            t.kind === 'opening_balance' &&
            t.postings.some(
              (p) => p.accountId === src.id && p.amount.currency === v.amount.currency,
            ),
        });
        if (dup.length)
          throw conflict(
            `the account already has an opening balance in ${v.amount.currency}; edit it instead`,
          );
        const t = await this.insertTransaction(tx, {
          ...base,
          kind: 'opening_balance',
          bookingDate: v.bookingDate,
          postings: [posting(this.newId, src.id, v.amount, 0, { memo: 'opening balance' })],
          splits: [],
          categorizationSource: 'none',
        });
        return t.id;
      }
      default:
        throw invalid({ kind: 'use createAdjustment for adjustments' });
    }
  }

  /** Refund splits: explicit, the categoryId shorthand, or the original's categories pro rata. */
  private async refundSplits(
    tx: StoreTx,
    originalId: string,
    amount: D.Money,
    input: { splits?: SplitIn[]; categoryId?: string | null },
    excludeId: string | undefined,
  ): Promise<D.Split[]> {
    const orig = await tx.get<D.Transaction>('transactions', originalId);
    if (!orig || orig.profileId !== this.profileId || orig.deletedAt || orig.kind !== 'expense')
      throw invalid({ relatedTransactionId: 'refunds link to an existing expense' });
    const origAmt = abs((orig.postings[0] as D.Posting).amount);
    if (origAmt.currency !== amount.currency)
      throw invalid({ amount: `refund currency must match the original (${origAmt.currency})` });
    const refunds = await this.all<D.Transaction>(tx, 'transactions', {
      index: 'relatedTransactionId',
      from: originalId,
      to: originalId,
      filter: (t) => t.kind === 'refund' && t.status !== 'void' && t.id !== excludeId,
    });
    const refunded = sum(
      refunds.flatMap((t) => t.postings.map((p) => p.amount)),
      origAmt.currency,
    );
    const total = add(refunded, amount);
    if (compare(total, origAmt) > 0)
      throw unprocessable('refunds would exceed the original amount', {
        refundable: fromMinor(toMinor(origAmt) - toMinor(refunded), origAmt.currency),
      });
    if (input.splits?.length || input.categoryId !== undefined)
      return buildSplits(this.newId, input.splits, input.categoryId, amount);
    const parts = allocate(
      amount,
      orig.splits.map((s) => s.amount.amount),
    );
    return orig.splits
      .map((s, i) => ({ s, amt: parts[i] as D.Money }))
      .filter(({ amt }) => toMinor(amt) > 0n)
      .map(({ s, amt }, i) => ({
        id: this.newId(),
        categoryId: s.categoryId,
        amount: amt,
        description: s.description,
        notes: '',
        sortOrder: i,
      }));
  }

  /** POST /transactions/{id}/refunds */
  async createRefund(originalId: string, input: RefundInput) {
    const v = parse(refundCreate, input);
    const id = await this.write(async (tx) => {
      const orig = await this.load<D.Transaction & Syncable>(
        tx,
        'transactions',
        originalId,
        'transaction',
      );
      return this.createTx(
        tx,
        {
          ...v,
          kind: 'refund',
          accountId: v.accountId ?? (orig.postings[0] as D.Posting).accountId,
          relatedTransactionId: originalId,
        },
        'manual',
      );
    });
    return this.getTransaction(id);
  }

  async getTransaction(id: string): Promise<D.Transaction> {
    return this.read((tx) =>
      this.load<D.Transaction & Syncable>(tx, 'transactions', id, 'transaction'),
    );
  }

  /** PATCH /transactions/{id}: interpretation edits; amounts/dates only for non-imported entries. */
  async updateTransaction(id: string, patch: TransactionPatch): Promise<D.Transaction> {
    const p = parse(S.transactionPatch, patch);
    await this.write(async (tx) => {
      const cur = await this.load<D.Transaction & Syncable>(tx, 'transactions', id, 'transaction');
      this.checkVersion(cur, p.version);
      const next: D.Transaction & Syncable = { ...cur };
      const imported = cur.importRecordId !== null;
      if (
        imported &&
        (p.amount || p.toAmount || (p.bookingDate && p.bookingDate !== cur.bookingDate))
      )
        throw conflict(
          'imported evidence: amount/date are fixed; record an adjustment instead',
          'imported_evidence',
        );
      for (const k of [
        'description',
        'notes',
        'payee',
        'reference',
        'bookingDate',
        'valueDate',
        'occurredAt',
        'status',
        'excludeFromReports',
      ] as const)
        if (p[k] !== undefined) (next as Record<string, unknown>)[k] = p[k];
      if (p.merchantId !== undefined) {
        await this.exists(tx, 'merchants', p.merchantId, 'merchantId');
        next.merchantId = p.merchantId;
      }
      if (p.tagIds) {
        for (const t of p.tagIds) await this.exists(tx, 'tags', t, 'tagIds');
        next.tagIds = p.tagIds;
      }
      if (p.amount || p.toAmount) this.applyAmount(next, p.amount, p.toAmount);
      if (p.categoryId !== undefined) {
        if (!SPLIT_KINDS.has(next.kind))
          throw invalid({ categoryId: `${next.kind} transactions are not categorized` });
        await this.exists(tx, 'categories', p.categoryId, 'categoryId');
        next.splits = buildSplits(
          this.newId,
          undefined,
          p.categoryId,
          (next.postings[0] as D.Posting).amount,
        );
        next.categorizationSource = 'user';
      }
      await this.replace(tx, 'transactions', cur, next);
    });
    return this.getTransaction(id);
  }

  /** New postings (immutable: replaced, never edited in place) for a changed amount. */
  private applyAmount(
    t: D.Transaction,
    amount: D.Money | undefined,
    toAmount: D.Money | undefined,
  ) {
    const [p0, p1] = t.postings as [D.Posting, D.Posting | undefined];
    const signedKinds = t.kind === 'opening_balance' || t.kind === 'adjustment';
    if (amount) {
      if (amount.currency !== p0.amount.currency)
        throw invalid({ amount: 'currency cannot change' });
      if (!signedKinds && toMinor(amount) <= 0n) throw invalid({ amount: 'must be positive' });
    }
    if (p1) {
      const a = amount ?? abs(p0.amount);
      let to = toAmount ?? (t.kind === 'transfer' ? a : abs(p1.amount));
      if (t.kind === 'transfer') to = a;
      if (to.currency !== p1.amount.currency) throw invalid({ toAmount: 'currency cannot change' });
      t.postings = [
        posting(this.newId, p0.accountId, negate(a), 0),
        posting(this.newId, p1.accountId, to, 1, { exchangeRateId: p1.exchangeRateId }),
      ];
      if (t.conversion) t.conversion = { ...t.conversion, from: a, to, method: 'bank_actual' };
      return;
    }
    if (!amount) throw invalid({ toAmount: 'only transfers have a toAmount' });
    const signed = t.kind === 'expense' ? negate(amount) : amount;
    t.postings = [
      posting(this.newId, p0.accountId, signed, 0, {
        originalAmount: p0.originalAmount,
        memo: p0.memo,
      }),
    ];
    if (SPLIT_KINDS.has(t.kind)) {
      if (t.splits.length > 1)
        throw unprocessable(
          'transaction has several splits; replace the splits with the new amount',
        );
      t.splits = buildSplits(this.newId, undefined, t.splits[0]?.categoryId ?? null, amount);
    }
  }

  /** PUT /transactions/{id}/splits */
  async replaceSplits(id: string, input: SplitsReplace): Promise<D.Transaction> {
    const v = parse(S.splitsReplace, input);
    await this.write(async (tx) => {
      const cur = await this.load<D.Transaction & Syncable>(tx, 'transactions', id, 'transaction');
      this.checkVersion(cur, v.version);
      if (!SPLIT_KINDS.has(cur.kind))
        throw invalid({ splits: `${cur.kind} transactions are not categorized` });
      const total = (cur.postings[0] as D.Posting).amount;
      let splits: D.Split[];
      if (v.splitTemplateId) {
        const tpl = await this.load<D.SplitTemplate & Syncable>(
          tx,
          'split_templates',
          v.splitTemplateId,
          'split template',
        );
        splits = applySplitTemplate(this.newId, tpl, total);
      } else {
        for (const s of v.splits ?? [])
          await this.exists(tx, 'categories', s.categoryId, 'splits.categoryId');
        splits = buildSplits(this.newId, v.splits, undefined, total);
      }
      await this.replace(tx, 'transactions', cur, { ...cur, splits, categorizationSource: 'user' });
    });
    return this.getTransaction(id);
  }

  /** POST /transactions/{id}/adjustments: correcting entry; the original evidence stays. */
  async createAdjustment(id: string, input: AdjustmentInput): Promise<D.Transaction> {
    const v = parse(S.adjustmentInput, input);
    const newId = await this.write(async (tx) => {
      const cur = await this.load<D.Transaction & Syncable>(tx, 'transactions', id, 'transaction');
      const accountId = v.accountId ?? (cur.postings[0] as D.Posting).accountId;
      if (!cur.postings.some((p) => p.accountId === accountId))
        throw invalid({ accountId: "must be one of the corrected transaction's accounts" });
      if (toMinor(v.amount) === 0n) throw invalid({ amount: 'must not be zero' });
      const t = await this.insertTransaction(tx, {
        kind: 'adjustment',
        bookingDate: v.bookingDate,
        description: v.reason,
        correctsTransactionId: id,
        postings: [posting(this.newId, accountId, v.amount, 0, { memo: 'adjustment' })],
        splits: [],
      });
      return t.id;
    });
    return this.getTransaction(newId);
  }

  /** DELETE /transactions/{id}: tombstone; imported ones are excluded from reports instead. */
  async deleteTransaction(id: string): Promise<void> {
    await this.write(async (tx) => {
      const cur = await this.load<D.Transaction & Syncable>(tx, 'transactions', id, 'transaction');
      if (cur.importRecordId)
        await this.replace(tx, 'transactions', cur, { ...cur, excludeFromReports: true });
      else await this.tombstone(tx, 'transactions', cur);
    });
  }

  /** POST /transactions/bulk */
  async bulkEdit(
    input: BulkEdit,
  ): Promise<{ updated: number; failed: { id: string; code: string; message: string }[] }> {
    const v = parse(S.bulkEdit, input);
    let updated = 0;
    const failed: { id: string; code: string; message: string }[] = [];
    for (const id of v.transactionIds) {
      try {
        await this.write(async (tx) => {
          const cur = await this.load<D.Transaction & Syncable>(
            tx,
            'transactions',
            id,
            'transaction',
          );
          const next: D.Transaction & Syncable = { ...cur, tagIds: [...cur.tagIds] };
          const s = v.set;
          if (s.categoryId !== undefined || s.clearCategory) {
            if (!SPLIT_KINDS.has(cur.kind))
              throw invalid({ categoryId: `${cur.kind} transactions are not categorized` });
            const cat = s.clearCategory ? null : (s.categoryId ?? null);
            await this.exists(tx, 'categories', cat, 'categoryId');
            next.splits = buildSplits(
              this.newId,
              undefined,
              cat,
              (cur.postings[0] as D.Posting).amount,
            );
            next.categorizationSource = cat ? 'user' : 'none';
          }
          if (s.merchantId !== undefined || s.clearMerchant) {
            next.merchantId = s.clearMerchant ? null : (s.merchantId ?? null);
            await this.exists(tx, 'merchants', next.merchantId, 'merchantId');
          }
          for (const t of s.addTagIds ?? []) {
            await this.exists(tx, 'tags', t, 'addTagIds');
            if (!next.tagIds.includes(t)) next.tagIds.push(t);
          }
          if (s.removeTagIds) next.tagIds = next.tagIds.filter((t) => !s.removeTagIds?.includes(t));
          if (s.excludeFromReports !== undefined) next.excludeFromReports = s.excludeFromReports;
          if (s.status) next.status = s.status;
          await this.replace(tx, 'transactions', cur, next);
        });
        updated++;
      } catch (e) {
        const err = e as ServiceError;
        failed.push({ id, code: err.code ?? 'error', message: err.message });
      }
    }
    return { updated, failed };
  }

  /** GET /transactions: keyset by (bookingDate desc, id desc). */
  async searchTransactions(f: TransactionFilter = {}): Promise<Page<D.Transaction>> {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
    let after: [string, string] | null = null;
    if (f.cursor) {
      const [d, i] = f.cursor.split('|');
      if (!d || !i) throw invalid({ cursor: 'invalid cursor' });
      after = [d, i];
    }
    const q = f.q?.toLowerCase();
    const accounts = f.accountIds?.length ? new Set(f.accountIds) : null;
    const rows = await this.read((tx) =>
      this.all<D.Transaction>(tx, 'transactions', {
        index: 'bookingDate',
        from: f.from,
        to: after ? after[0] : f.to,
        reverse: true,
        includeDeleted: f.includeDeleted,
        limit: limit + 1,
        filter: (t) => {
          if (
            after &&
            (t.bookingDate > after[0] || (t.bookingDate === after[0] && t.id >= after[1]))
          )
            return false;
          if (f.to && t.bookingDate > f.to) return false;
          if (accounts && !t.postings.some((p) => accounts.has(p.accountId))) return false;
          if (f.categoryId && !t.splits.some((s) => s.categoryId === f.categoryId)) return false;
          if (f.merchantId && t.merchantId !== f.merchantId) return false;
          if (f.tagId && !t.tagIds.includes(f.tagId)) return false;
          if (f.kind && t.kind !== f.kind) return false;
          if (
            f.uncategorized &&
            !(SPLIT_KINDS.has(t.kind) && t.splits.some((s) => s.categoryId === null))
          )
            return false;
          if (
            q &&
            !`${t.description}\n${t.payee}\n${t.notes}\n${t.reference}`.toLowerCase().includes(q)
          )
            return false;
          const amt = t.postings[0] ? abs(t.postings[0].amount) : null;
          if (amt && f.minAmount && compareDecimal(amt.amount, f.minAmount) < 0) return false;
          if (amt && f.maxAmount && compareDecimal(amt.amount, f.maxAmount) > 0) return false;
          return true;
        },
      }),
    );
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return rows.length > limit && last
      ? { items, nextCursor: `${last.bookingDate}|${last.id}` }
      : { items };
  }

  // ------------------------------------------------------------ automation

  /** Apply enabled categorization rules to the given (or all uncategorized) transactions. */
  async applyRules(transactionIds?: string[]): Promise<{ matched: number }> {
    return this.write(async (tx) => {
      const rules = await this.all<D.CategorizationRule & Syncable>(tx, 'categorization_rules');
      const ids = transactionIds ? new Set(transactionIds) : null;
      const txs = await this.all<D.Transaction & Syncable>(tx, 'transactions', {
        filter: (t) =>
          SPLIT_KINDS.has(t.kind) &&
          (ids
            ? ids.has(t.id)
            : t.categorizationSource === 'none' || t.categorizationSource === 'import'),
      });
      const hits = new Map<string, number>();
      let matched = 0;
      for (const t of txs) {
        const r = await this.ruleOutcome(tx, t, rules);
        if (!r) continue;
        matched++;
        for (const id of r.matchedRuleIds) hits.set(id, (hits.get(id) ?? 0) + 1);
        await this.replace(tx, 'transactions', t, r.next);
      }
      for (const rule of rules) {
        const n = hits.get(rule.id);
        if (n)
          await this.replace(tx, 'categorization_rules', rule, {
            ...rule,
            matchCount: rule.matchCount + n,
            lastMatchedAt: this.ts(),
          });
      }
      return { matched };
    });
  }

  private async ruleOutcome(
    tx: StoreTx,
    t: D.Transaction & Syncable,
    rules: D.CategorizationRule[],
  ) {
    const p0 = t.postings[0];
    if (!p0) return null;
    const o = evaluateRules(rules, {
      description: t.description,
      payee: t.payee,
      amount: p0.amount,
      accountId: p0.accountId,
      merchantId: t.merchantId,
    });
    if (o.matchedRuleIds.length === 0) return null;
    const next: D.Transaction & Syncable = {
      ...t,
      tagIds: [...new Set([...t.tagIds, ...o.tagIds])],
    };
    if (o.merchantId) next.merchantId = o.merchantId;
    if (o.description) next.description = o.description;
    if (o.excludeFromReports) next.excludeFromReports = true;
    if (o.splitTemplateId) {
      const tpl = await tx.get<D.SplitTemplate>('split_templates', o.splitTemplateId);
      if (tpl && !tpl.deletedAt) {
        next.splits = applySplitTemplate(this.newId, tpl, p0.amount);
        next.categorizationSource = 'rule';
      }
    } else if (o.categoryId) {
      next.splits = buildSplits(this.newId, undefined, o.categoryId, p0.amount);
      next.categorizationSource = 'rule';
    }
    return { next, matchedRuleIds: o.matchedRuleIds };
  }

  // ------------------------------------------------------------ calculations

  /** All live transactions in engine shape (analytics, dashboard, forecasts run on this). */
  async ledger(): Promise<LedgerTransaction[]> {
    return this.read((tx) => this.all<D.Transaction>(tx, 'transactions')) as Promise<
      LedgerTransaction[]
    >;
  }

  async balances(asOf?: string): Promise<AccountBalance[]> {
    return accountBalances(await this.ledger(), asOf);
  }

  async rateSnapshots(): Promise<RateSnapshot[]> {
    return this.read((tx) => this.rates(tx));
  }

  async addExchangeRate(input: z.input<typeof S.exchangeRateInput>): Promise<D.ExchangeRate> {
    const v = parse(S.exchangeRateInput, input);
    const r: D.ExchangeRate & { deletedAt: null } = {
      id: v.id ?? this.newId(),
      providerCode: null,
      profileId: this.profileId,
      baseCurrency: v.baseCurrency,
      quoteCurrency: v.quoteCurrency,
      rate: v.rate,
      rateDate: v.rateDate,
      source: 'manual',
      fetchedAt: this.ts(),
      deletedAt: null,
    };
    createRateBook([{ ...r }]); // validates the rate (positive)
    await this.write((tx) => tx.put('exchange_rates', r));
    return r;
  }

  async budgetStatus(budgetId: string, date = this.today()): Promise<BudgetStatus> {
    return this.read(async (tx) => {
      const b = await this.load<D.Budget & Syncable>(tx, 'budgets', budgetId, 'budget');
      const [allocations, transactions, categories, rates, occ] = [
        await this.all<D.BudgetAllocation>(tx, 'budget_allocations', {
          index: 'budgetId',
          from: budgetId,
          to: budgetId,
        }),
        await this.all<D.Transaction>(tx, 'transactions'),
        await this.all<D.Category>(tx, 'categories', { includeDeleted: true }),
        await this.rates(tx),
        await this.occurrencesTx(tx, b.startDate, b.endDate ?? addMonths(date, 12)),
      ];
      const plans = new Map(
        (await this.all<D.PlannedTransaction>(tx, 'planned_transactions')).map((p) => [p.id, p]),
      );
      return budgetStatus({
        budget: b,
        allocations,
        transactions: transactions as LedgerTransaction[],
        categories,
        planned: occ
          .filter((o) => plans.get(o.planId)?.kind === 'expense')
          .map((o) => ({
            date: o.date,
            categoryId: plans.get(o.planId)?.categoryId ?? null,
            amount: o.amount,
          })),
        date,
        convert: reportingConverter(createRateBook(rates), b.currency),
      });
    });
  }

  private async occurrencesTx(tx: StoreTx, from: string, to: string, includeOverdue = false) {
    return planOccurrences(
      await this.all<D.PlannedTransaction>(tx, 'planned_transactions'),
      await this.all<D.RecurrenceSchedule>(tx, 'recurrence_schedules'),
      await this.all<D.PlannedOccurrence>(tx, 'planned_occurrences'),
      from,
      to,
      { includeOverdue },
    );
  }

  /** GET /plans/occurrences (bill calendar, upcoming expenses, forecasts). */
  async planOccurrences(
    from: string,
    to: string,
    includeOverdue = false,
  ): Promise<PlanOccurrence[]> {
    return this.read((tx) => this.occurrencesTx(tx, from, to, includeOverdue));
  }

  /** PUT /plans/{id}/occurrences/{date}: skip, mark paid, match, or override amount/date. */
  async setOccurrence(
    planId: string,
    occurrenceDate: string,
    v: Partial<
      Pick<
        D.PlannedOccurrence,
        'status' | 'amountOverride' | 'dateOverride' | 'matchedTransactionId'
      >
    >,
  ): Promise<D.PlannedOccurrence> {
    return this.write(async (tx) => {
      await this.load(tx, 'planned_transactions', planId, 'plan');
      if (v.matchedTransactionId)
        await this.exists(tx, 'transactions', v.matchedTransactionId, 'matchedTransactionId');
      if (v.status === 'matched' && !v.matchedTransactionId)
        throw invalid({ matchedTransactionId: 'required' });
      const [cur] = await this.all<D.PlannedOccurrence & Syncable>(tx, 'planned_occurrences', {
        index: 'plannedTransactionId',
        from: planId,
        to: planId,
        filter: (o) => o.occurrenceDate === occurrenceDate,
      });
      if (cur) return this.replace(tx, 'planned_occurrences', cur, { ...cur, ...v });
      return this.insert<D.PlannedOccurrence & Syncable>(tx, 'planned_occurrences', {
        plannedTransactionId: planId,
        occurrenceDate,
        status: 'pending',
        amountOverride: null,
        dateOverride: null,
        matchedTransactionId: null,
        ...v,
      } as never);
    });
  }

  async goalProgress(
    goalId: string,
  ): Promise<{ saved: D.Money; target: D.Money; remaining: D.Money }> {
    return this.read(async (tx) => {
      const g = await this.load<D.SavingsGoal & Syncable>(tx, 'savings_goals', goalId, 'goal');
      const cs = await this.all<D.SavingsContribution>(tx, 'savings_contributions', {
        index: 'goalId',
        from: goalId,
        to: goalId,
      });
      const saved = sum([g.startingAmount, ...cs.map((c) => c.amount)], g.targetAmount.currency);
      return {
        saved,
        target: g.targetAmount,
        remaining: fromMinor(toMinor(g.targetAmount) - toMinor(saved), saved.currency),
      };
    });
  }

  // ------------------------------------------------------------ imports

  /** Stage a parsed statement: immutable raw records + batch; duplicates found by fp1 fingerprint. */
  async stageImport(input: StageImportInput): Promise<ImportPreview> {
    const batchId = await this.write(async (tx) => {
      const acc = await this.account(tx, input.accountId, 'accountId');
      const dates = input.records.map((r) => r.postingDate).sort();
      const batch = await this.insert<D.ImportBatch & Syncable>(tx, 'import_batches', {
        accountId: acc.id,
        importerId: input.importerId,
        importerVersion: input.importerVersion,
        templateId: null,
        fileName: input.fileName,
        fileSha256: input.fileSha256,
        fileSize: input.fileSize,
        status: 'staged',
        coverageStart: dates[0] ?? null,
        coverageEnd: dates[dates.length - 1] ?? null,
        stats: { records: input.records.length },
        error: null,
        committedAt: null,
        rolledBackAt: null,
      } as never);
      for (const r of input.records) {
        if (r.currency !== acc.currency && !acc.isMultiCurrency)
          throw invalid({
            [`records.${r.rowNumber}`]: `currency ${r.currency} does not match the account`,
          });
        const amount = fromMinor(
          (r.direction === 'debit' ? -1n : 1n) *
            toMinor({ amount: r.amount, currency: r.currency }),
          r.currency,
        );
        const rec: D.ImportedRawRecord & { profileId: string; deletedAt: null } = {
          id: this.newId(),
          profileId: this.profileId,
          importBatchId: batch.id,
          accountId: acc.id,
          rowNumber: r.rowNumber,
          sourceDescription: r.description,
          postingDate: r.postingDate,
          valueDate: r.valueDate ?? null,
          amount,
          direction: r.direction,
          originalAmount:
            r.originalAmount && r.originalCurrency
              ? { amount: r.originalAmount, currency: r.originalCurrency }
              : null,
          exchangeRate: r.exchangeRate ?? null,
          runningBalance: r.runningBalance
            ? { amount: r.runningBalance, currency: r.currency }
            : null,
          bankReference: r.bankReference ?? '',
          statementRef: r.statementRef ?? '',
          sourceAccount: r.accountRef ?? '',
          counterparty: r.counterparty ?? '',
          raw: r.raw,
          dedupeFingerprint: r.fingerprint,
          importerId: input.importerId,
          importerVersion: input.importerVersion,
          warnings: (r.warnings ?? []).map((w) => w.message),
          createdAt: this.ts(),
          deletedAt: null,
        };
        await tx.put('imported_raw_records', rec);
      }
      if (input.source)
        await tx.put('blobs', {
          id: importSourceKey(batch.id),
          profileId: this.profileId,
          blob: input.source,
          statements: input.statements ?? [],
        });
      return batch.id;
    });
    return this.importPreview(batchId);
  }

  async importPreview(batchId: string): Promise<ImportPreview> {
    return this.read(async (tx) => {
      const batch = await this.load<D.ImportBatch & Syncable>(
        tx,
        'import_batches',
        batchId,
        'import',
      );
      const records = await this.all<D.ImportedRawRecord>(tx, 'imported_raw_records', {
        index: 'importBatchId',
        from: batchId,
        to: batchId,
      });
      const rows: StagedRow[] = [];
      const seen = new Map<string, string>();
      let income = 0n;
      let expenses = 0n;
      const cur = records[0]?.amount.currency ?? 'XXX';
      for (const r of records.sort((a, b) => a.rowNumber - b.rowNumber)) {
        const earlier = await this.all<D.ImportedRawRecord>(tx, 'imported_raw_records', {
          index: 'dedupeFingerprint',
          from: r.dedupeFingerprint,
          to: r.dedupeFingerprint,
          filter: (o) => o.importBatchId !== batchId && o.accountId === r.accountId,
        });
        const committed = [];
        for (const o of earlier) {
          const [t] = await this.all<D.Transaction>(tx, 'transactions', {
            index: 'importRecordId',
            from: o.id,
            to: o.id,
          });
          if (t) committed.push(o);
        }
        const dupOf = committed[0]?.id ?? seen.get(r.dedupeFingerprint) ?? null;
        seen.set(r.dedupeFingerprint, r.id);
        rows.push({ record: r, outcome: dupOf ? 'duplicate' : 'new', duplicateOf: dupOf });
        const a = toMinor(r.amount);
        if (!dupOf && a < 0n) expenses -= a;
        else if (!dupOf) income += a;
      }
      return {
        batch,
        rows,
        totals: {
          income: fromMinor(income, cur),
          expenses: fromMinor(expenses, cur),
          count: rows.length,
          duplicates: rows.filter((r) => r.outcome === 'duplicate').length,
        },
      };
    });
  }

  /** Create transactions for the selected (default: non-duplicate) rows; rules run on them. */
  async commitImport(batchId: string, rows: CommitRow[] = []): Promise<D.ImportBatch> {
    const preview = await this.importPreview(batchId);
    if (preview.batch.status !== 'staged')
      throw conflict(`import is ${preview.batch.status}`, 'import_state');
    const sel = new Map(rows.map((r) => [r.rawRecordId, r]));
    await this.write(async (tx) => {
      const rules = await this.all<D.CategorizationRule>(tx, 'categorization_rules');
      let created = 0;
      for (const row of preview.rows) {
        const choice = sel.get(row.record.id);
        if (!(choice?.selected ?? row.outcome === 'new')) continue;
        const r = row.record;
        const t = await this.insertTransaction(tx, {
          kind: toMinor(r.amount) < 0n ? 'expense' : 'income',
          bookingDate: r.postingDate,
          valueDate: r.valueDate,
          description: choice?.description ?? r.sourceDescription,
          payee: r.counterparty,
          reference: r.bankReference,
          source: 'import',
          importRecordId: r.id,
          categorizationSource: choice?.categoryId ? 'user' : 'import',
          postings: [
            posting(this.newId, r.accountId as string, r.amount, 0, {
              originalAmount: r.originalAmount,
            }),
          ],
          splits: buildSplits(this.newId, undefined, choice?.categoryId ?? null, r.amount),
        });
        if (!choice?.categoryId) {
          const o = await this.ruleOutcome(tx, t as D.Transaction & Syncable, rules);
          if (o) await this.replace(tx, 'transactions', t as D.Transaction & Syncable, o.next);
        }
        created++;
      }
      const b = await this.load<D.ImportBatch & Syncable>(tx, 'import_batches', batchId);
      await this.replace(tx, 'import_batches', b, {
        ...b,
        status: 'committed',
        committedAt: this.ts(),
        stats: { ...b.stats, created, duplicates: preview.totals.duplicates },
      });
    });
    return this.read((tx) => this.load<D.ImportBatch & Syncable>(tx, 'import_batches', batchId));
  }

  /** Tombstones only the transactions created by this batch; raw evidence is kept. */
  async rollbackImport(batchId: string): Promise<D.ImportBatch> {
    await this.write(async (tx) => {
      const b = await this.load<D.ImportBatch & Syncable>(tx, 'import_batches', batchId, 'import');
      if (b.status !== 'committed') throw conflict(`import is ${b.status}`, 'import_state');
      const recs = await this.all<D.ImportedRawRecord>(tx, 'imported_raw_records', {
        index: 'importBatchId',
        from: batchId,
        to: batchId,
      });
      for (const r of recs)
        for (const t of await this.all<D.Transaction & Syncable>(tx, 'transactions', {
          index: 'importRecordId',
          from: r.id,
          to: r.id,
        }))
          await this.tombstone(tx, 'transactions', t);
      await this.replace(tx, 'import_batches', b, {
        ...b,
        status: 'rolled_back',
        rolledBackAt: this.ts(),
      });
    });
    return this.read((tx) => this.load<D.ImportBatch & Syncable>(tx, 'import_batches', batchId));
  }

  async listImports(): Promise<D.ImportBatch[]> {
    return this.read((tx) => this.all<D.ImportBatch>(tx, 'import_batches'));
  }

  // ------------------------------------------------------------ attachments

  async addAttachment(input: LocalAttachmentInput): Promise<D.Attachment> {
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return this.write(async (tx) => {
      const id = this.newId();
      if (input.transactionId)
        await this.load(tx, 'transactions', input.transactionId, 'transaction');
      await tx.put('blobs', { id, profileId: this.profileId, blob: input.file });
      const a = await this.insert<D.Attachment & Syncable>(tx, 'attachments', {
        id,
        transactionId: input.transactionId ?? null,
        fileName: input.fileName.slice(0, 255),
        contentType: input.contentType || input.file.type || 'application/octet-stream',
        sizeBytes: bytes.byteLength,
        sha256: sha,
        isEncrypted: false,
        purpose: input.purpose ?? 'receipt',
      } as never);
      if (input.transactionId) {
        const t = await this.load<D.Transaction & Syncable>(
          tx,
          'transactions',
          input.transactionId,
        );
        await this.replace(tx, 'transactions', t, {
          ...t,
          attachmentIds: [...t.attachmentIds, id],
        });
      }
      return a;
    });
  }

  async listAttachments(transactionId?: string): Promise<D.Attachment[]> {
    return this.read((tx) =>
      this.all<D.Attachment>(
        tx,
        'attachments',
        transactionId ? { index: 'transactionId', from: transactionId, to: transactionId } : {},
      ),
    );
  }

  async attachmentContent(id: string): Promise<Blob> {
    const local = await this.read(async (tx) => {
      await this.load(tx, 'attachments', id, 'attachment');
      const b = await tx.get<{ blob: Blob; profileId: string }>('blobs', id);
      return b && b.profileId === this.profileId ? b.blob : null;
    });
    if (local) return local;
    if (!this.fetchAttachment) throw notFound('attachment content');
    const blob = await this.fetchAttachment(id);
    await this.store.run('readwrite', ['blobs'], (tx) =>
      tx.put('blobs', { id, profileId: this.profileId, blob }),
    );
    return blob;
  }

  async removeAttachment(id: string): Promise<void> {
    await this.write(async (tx) => {
      const a = await this.load<D.Attachment & Syncable>(tx, 'attachments', id, 'attachment');
      if (a.transactionId) {
        const t = await tx.get<D.Transaction & Syncable>('transactions', a.transactionId);
        if (t && !t.deletedAt)
          await this.replace(tx, 'transactions', t, {
            ...t,
            attachmentIds: t.attachmentIds.filter((x) => x !== id),
          });
      }
      await this.tombstone(tx, 'attachments', a);
      await tx.delete('blobs', id);
    });
  }

  // ------------------------------------------------------------ settings, notifications

  async getSettings(): Promise<Record<string, unknown>> {
    const rows = await this.read((tx) => this.all<{ key: string; value: unknown }>(tx, 'settings'));
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) throw invalid({ key: 'invalid setting key' });
    await this.write((tx) =>
      tx.put('settings', {
        id: `${this.profileId}:${key}`,
        profileId: this.profileId,
        key,
        value,
        updatedAt: this.ts(),
        dirty: true, // connected mode uploads it (sync-client engine syncSettings)
      }),
    );
  }

  async getDashboardLayout<T = unknown>(): Promise<T | null> {
    return ((await this.getSettings())['dashboard.layout'] as T | undefined) ?? null;
  }

  setDashboardLayout(layout: unknown): Promise<void> {
    return this.setSetting('dashboard.layout', layout);
  }

  async notify(
    n: Pick<D.Notification, 'kind' | 'severity' | 'title' | 'body'> & {
      data?: Record<string, unknown>;
      dedupeKey?: string;
    },
  ) {
    return this.write(async (tx) => {
      if (n.dedupeKey) {
        const dup = await this.all<D.Notification & { dedupeKey?: string }>(tx, 'notifications', {
          filter: (x) => x.dedupeKey === n.dedupeKey,
          limit: 1,
        });
        if (dup[0]) return dup[0];
      }
      const row = {
        id: this.newId(),
        profileId: this.profileId,
        kind: n.kind,
        severity: n.severity,
        title: n.title,
        body: n.body,
        data: n.data ?? {},
        dedupeKey: n.dedupeKey,
        readAt: null,
        createdAt: this.ts(),
      };
      await tx.put('notifications', row);
      return row as D.Notification;
    });
  }

  async listNotifications(unreadOnly = false): Promise<D.Notification[]> {
    return this.read((tx) =>
      this.all<D.Notification>(tx, 'notifications', {
        index: 'createdAt',
        reverse: true,
        filter: (n) => !unreadOnly || !n.readAt,
      }),
    );
  }

  async markNotificationRead(id?: string): Promise<void> {
    await this.write(async (tx) => {
      for (const n of await this.all<D.Notification>(tx, 'notifications', {
        filter: (n) => !n.readAt && (!id || n.id === id),
      }))
        await tx.put('notifications', { ...n, readAt: this.ts() });
    });
  }
}
