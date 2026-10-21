// Automation: categorization rules, history-based suggestions, duplicate detection and recurring
// pattern detection. Deterministic and explainable; the Go automation module mirrors these rules
// (packages/test-fixtures/conformance/automation.json).
import {
  countsInReports,
  isLive,
  type LedgerTransaction,
  merchantKey,
  normalizeMerchantName,
} from './analytics.ts';
import { diffDays, parseDate, toEpochDay } from './dates.ts';
import { compareDecimal } from './decimal.ts';
import { fromMinor, type Money, toMinor } from './money.ts';

// ---------------------------------------------------------------- rules

export type RuleCondition =
  | {
      field: 'description' | 'payee' | 'counterparty';
      op: 'contains' | 'equals' | 'starts_with' | 'regex';
      value: string;
      caseSensitive?: boolean;
    }
  | { field: 'amount'; op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'; value: string }
  | { field: 'accountId' | 'merchantId'; op: 'equals'; value: string }
  | { field: 'direction'; op: 'equals'; value: 'debit' | 'credit' };

export type RuleAction =
  | { type: 'set_category'; categoryId: string }
  | { type: 'set_merchant'; merchantId: string }
  | { type: 'add_tag'; tagId: string }
  | { type: 'set_description'; value: string }
  | { type: 'apply_split_template'; splitTemplateId: string }
  | { type: 'exclude_from_reports' };

export interface RuleLike {
  id: string;
  priority: number;
  conditions: readonly RuleCondition[];
  actions: readonly RuleAction[];
  enabled: boolean;
  stopProcessing: boolean;
  deletedAt?: string | null;
}

export interface RuleSubject {
  description?: string;
  payee?: string;
  counterparty?: string;
  amount: Money; // signed: negative = debit
  accountId?: string | null;
  merchantId?: string | null;
}

export interface RuleOutcome {
  categoryId: string | null;
  merchantId: string | null;
  description: string | null;
  splitTemplateId: string | null;
  tagIds: string[];
  excludeFromReports: boolean;
  matchedRuleIds: string[];
}

export const MAX_RULE_REGEX_LENGTH = 256;
const regexCache = new Map<string, RegExp | null>();

function compileRegex(src: string, flags: string): RegExp | null {
  const k = `${flags}/${src}`;
  if (!regexCache.has(k)) {
    let re: RegExp | null = null;
    if (src.length <= MAX_RULE_REGEX_LENGTH) {
      try {
        re = new RegExp(src, flags);
      } catch {
        re = null; // invalid pattern never matches
      }
    }
    regexCache.set(k, re);
  }
  return regexCache.get(k) ?? null;
}

/**
 * Rule semantics: enabled rules run in ascending priority (ties by id). All conditions must hold
 * (AND; a rule without conditions never matches). Text ops are case-insensitive unless
 * caseSensitive; regex uses the RE2-compatible subset (no backreferences/lookaround) and an invalid
 * or over-long pattern never matches. Amount ops compare |amount| (use `direction` for sign).
 * For set_* actions the first matching rule wins; add_tag accumulates (deduplicated, in order).
 * stopProcessing ends evaluation after that rule matches.
 */
export function evaluateRules(rules: readonly RuleLike[], subject: RuleSubject): RuleOutcome {
  const out: RuleOutcome = {
    categoryId: null,
    merchantId: null,
    description: null,
    splitTemplateId: null,
    tagIds: [],
    excludeFromReports: false,
    matchedRuleIds: [],
  };
  const active = rules
    .filter((r) => r.enabled && !r.deletedAt && r.conditions.length > 0)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const r of active) {
    if (!r.conditions.every((c) => matches(c, subject))) continue;
    out.matchedRuleIds.push(r.id);
    for (const a of r.actions) {
      switch (a.type) {
        case 'set_category':
          out.categoryId ??= a.categoryId;
          break;
        case 'set_merchant':
          out.merchantId ??= a.merchantId;
          break;
        case 'set_description':
          out.description ??= a.value;
          break;
        case 'apply_split_template':
          out.splitTemplateId ??= a.splitTemplateId;
          break;
        case 'add_tag':
          if (!out.tagIds.includes(a.tagId)) out.tagIds.push(a.tagId);
          break;
        case 'exclude_from_reports':
          out.excludeFromReports = true;
          break;
      }
    }
    if (r.stopProcessing) break;
  }
  return out;
}

function matches(c: RuleCondition, s: RuleSubject): boolean {
  switch (c.field) {
    case 'description':
    case 'payee':
    case 'counterparty': {
      const raw = s[c.field] ?? '';
      if (c.op === 'regex')
        return compileRegex(c.value, c.caseSensitive ? 'u' : 'iu')?.test(raw) ?? false;
      const v = c.caseSensitive ? c.value : c.value.toLowerCase();
      const t = c.caseSensitive ? raw : raw.toLowerCase();
      if (c.op === 'equals') return t === v;
      if (c.op === 'starts_with') return t.startsWith(v);
      return t.includes(v);
    }
    case 'amount': {
      const a = s.amount.amount.replace(/^-/, '');
      const d = compareDecimal(a, c.value);
      return { eq: d === 0, lt: d < 0, lte: d <= 0, gt: d > 0, gte: d >= 0 }[c.op];
    }
    case 'accountId':
      return s.accountId === c.value;
    case 'merchantId':
      return s.merchantId === c.value;
    case 'direction':
      return (toMinor(s.amount) < 0n ? 'debit' : 'credit') === c.value;
  }
}

// ---------------------------------------------------------------- suggestions

export interface Suggestion {
  transactionId: string;
  field: 'category';
  value: string;
  confidence: string;
  reason: string;
}

const TRUSTED_SOURCES = new Set(['user', 'rule', 'import', 'mcp']);

export type CategoryHistory = Map<string, Map<string, { n: number; last: string }>>;

/**
 * Index of past categorizations: key = merchantId, else "name:<normalized payee/description>".
 * Only income/expense transactions categorized by user, rule, import or MCP count (never earlier
 * suggestions); each contributes the category of its largest split (ties: first split).
 */
export function buildCategoryHistory(txs: readonly LedgerTransaction[]): CategoryHistory {
  const h: CategoryHistory = new Map();
  for (const t of txs) {
    if (!isLive(t) || (t.kind !== 'expense' && t.kind !== 'income')) continue;
    if (!TRUSTED_SOURCES.has(t.categorizationSource ?? '')) continue;
    let best: { categoryId: string | null; v: bigint } | null = null;
    for (const s of t.splits ?? []) {
      const v = toMinor(s.amount);
      if (!best || v > best.v) best = { categoryId: s.categoryId, v };
    }
    if (!best?.categoryId) continue;
    const key = merchantKey(t);
    if (key === 'name:') continue;
    const m = h.get(key) ?? new Map();
    const e = m.get(best.categoryId) ?? { n: 0, last: '' };
    e.n++;
    if (t.bookingDate > e.last) e.last = t.bookingDate;
    m.set(best.categoryId, e);
    h.set(key, m);
  }
  return h;
}

/**
 * Most frequent past category for the transaction's merchant key (ties: most recent, then id).
 * confidence = top count / all counts for the key (2 decimals, rounded down).
 */
export function suggestCategory(history: CategoryHistory, t: LedgerTransaction): Suggestion | null {
  const m = history.get(merchantKey(t));
  if (!m) return null;
  let top: [string, { n: number; last: string }] | null = null;
  let total = 0;
  for (const e of m) {
    total += e[1].n;
    if (
      !top ||
      e[1].n > top[1].n ||
      (e[1].n === top[1].n &&
        (e[1].last > top[1].last || (e[1].last === top[1].last && e[0] < top[0])))
    )
      top = e;
  }
  if (!top) return null;
  const conf = Math.floor((top[1].n * 100) / total);
  return {
    transactionId: t.id,
    field: 'category',
    value: top[0],
    confidence: (conf / 100).toFixed(2),
    reason: `${top[1].n} of ${total} earlier transactions with this ${t.merchantId ? 'merchant' : 'payee'} used this category`,
  };
}

// ---------------------------------------------------------------- duplicates

export interface DuplicateGroup {
  transactionIds: string[];
  score: string;
  reasons: string[];
}

/**
 * Possible duplicates: two live transactions with a posting on the same account with the same
 * signed amount, booked at most `windowDays` apart, unless BOTH are imported (two imported rows are
 * distinct bank evidence; re-imports are caught by the import fingerprint). Score in hundredths:
 * 50 base + 30 same date (else 10) + 20 same normalized description (else 10 if they share a word
 * of >= 3 letters). Pairs scoring >= 60 are linked; groups are connected components, scored by
 * their best pair, sorted by score desc then first id.
 */
export function findDuplicates(
  txs: readonly LedgerTransaction[],
  windowDays = 3,
): DuplicateGroup[] {
  const buckets = new Map<string, { t: LedgerTransaction; day: number; name: string }[]>();
  for (const t of txs) {
    if (!isLive(t)) continue;
    const day = toEpochDay(t.bookingDate);
    const name = normalizeMerchantName(t.payee || t.description || '');
    for (const p of t.postings) {
      const k = `${p.accountId}|${p.amount.currency}|${toMinor(p.amount)}`;
      const list = buckets.get(k) ?? [];
      list.push({ t, day, name });
      buckets.set(k, list);
    }
  }
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  const best = new Map<string, number>();
  const reasons = new Map<string, Set<string>>();
  const pairs: [string, string, number, string[]][] = [];
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.day - b.day || a.t.id.localeCompare(b.t.id));
    for (let i = 0; i < list.length; i++) {
      const a = list[i] as (typeof list)[number];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j] as (typeof list)[number];
        if (b.day - a.day > windowDays) break;
        if (a.t.id === b.t.id || (a.t.importRecordId && b.t.importRecordId)) continue;
        const why = ['same account and amount'];
        let s = 50;
        if (a.day === b.day) {
          s += 30;
          why.push('same date');
        } else {
          s += 10;
          why.push(`${b.day - a.day} day(s) apart`);
        }
        if (a.name && a.name === b.name) {
          s += 20;
          why.push('same description');
        } else if (a.name && b.name && sharesWord(a.name, b.name)) {
          s += 10;
          why.push('similar description');
        }
        if (s >= 60) pairs.push([a.t.id, b.t.id, s, why]);
      }
    }
  }
  for (const [a, b] of pairs) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, Set<string>>();
  for (const [a, b, s, why] of pairs) {
    const r = find(a);
    const g = groups.get(r) ?? new Set();
    g.add(a);
    g.add(b);
    groups.set(r, g);
    best.set(r, Math.max(best.get(r) ?? 0, s));
    const rs = reasons.get(r) ?? new Set();
    for (const w of why) rs.add(w);
    reasons.set(r, rs);
  }
  return [...groups.entries()]
    .map(([r, ids]) => ({
      transactionIds: [...ids].sort(),
      score: ((best.get(r) ?? 0) / 100).toFixed(2),
      reasons: [...(reasons.get(r) ?? [])],
    }))
    .sort(
      (a, b) =>
        Number(b.score) - Number(a.score) ||
        (a.transactionIds[0] ?? '').localeCompare(b.transactionIds[0] ?? ''),
    );
}

function sharesWord(a: string, b: string): boolean {
  const x = new Set(a.split(' ').filter((w) => w.length >= 3));
  return b.split(' ').some((w) => x.has(w));
}

// ---------------------------------------------------------------- recurring patterns

export interface RecurringCandidate {
  merchantId: string | null;
  description: string;
  kind: 'expense' | 'income';
  amount: Money; // positive magnitude of the latest occurrence
  rrule: string;
  cadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
  lastDate: string;
  transactionIds: string[];
  confidence: string;
}

const CADENCES = [
  { name: 'weekly', min: 6, max: 8, days: 7 },
  { name: 'biweekly', min: 12, max: 16, days: 14 },
  { name: 'monthly', min: 27, max: 34, days: 31 },
  { name: 'quarterly', min: 85, max: 98, days: 92 },
  { name: 'yearly', min: 355, max: 376, days: 366 },
] as const;

/**
 * Detect subscriptions / recurring charges. Groups counted income/expense transactions by merchant
 * key + currency + kind. A group of >= minOccurrences qualifies when its median gap (lower median)
 * falls in a cadence range (weekly 6–8, biweekly 12–16, monthly 27–34, quarterly 85–98,
 * yearly 355–376 days), >= 75% of gaps are in that range and >= 75% of amounts are within 10% of the
 * median amount, and the last occurrence is no older than 2 cadence lengths before asOf.
 * confidence = gapRatio * amountRatio rounded down to 2 decimals. rrule: weekly FREQ=WEEKLY;
 * biweekly FREQ=WEEKLY;INTERVAL=2; monthly FREQ=MONTHLY;BYMONTHDAY=<most common day, ties: latest>;
 * quarterly FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=<day>; yearly FREQ=YEARLY.
 */
export function detectRecurring(
  txs: readonly LedgerTransaction[],
  asOf: string,
  minOccurrences = 3,
): RecurringCandidate[] {
  const groups = new Map<string, LedgerTransaction[]>();
  for (const t of txs) {
    if ((t.kind !== 'expense' && t.kind !== 'income') || !countsInReports(t)) continue;
    const p = t.postings[0];
    if (!p) continue;
    const k = `${merchantKey(t)}|${p.amount.currency}|${t.kind}`;
    if (k.startsWith('name:|')) continue;
    const g = groups.get(k) ?? [];
    g.push(t);
    groups.set(k, g);
  }
  const out: RecurringCandidate[] = [];
  for (const g of groups.values()) {
    if (g.length < minOccurrences) continue;
    g.sort((a, b) =>
      a.bookingDate < b.bookingDate
        ? -1
        : a.bookingDate > b.bookingDate
          ? 1
          : a.id.localeCompare(b.id),
    );
    const gaps: number[] = [];
    for (let i = 1; i < g.length; i++)
      gaps.push(
        diffDays(
          (g[i] as LedgerTransaction).bookingDate,
          (g[i - 1] as LedgerTransaction).bookingDate,
        ),
      );
    const med = [...gaps].sort((a, b) => a - b)[Math.floor((gaps.length - 1) / 2)] as number;
    const c = CADENCES.find((x) => med >= x.min && med <= x.max);
    if (!c) continue;
    const okGaps = gaps.filter((d) => d >= c.min && d <= c.max).length;
    const amts = g.map((t) => {
      const v = t.postings.reduce((a, p) => a + toMinor(p.amount), 0n);
      return v < 0n ? -v : v;
    });
    const sortedAmts = [...amts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const medAmt = sortedAmts[Math.floor((sortedAmts.length - 1) / 2)] as bigint;
    const okAmts = amts.filter(
      (a) => (a > medAmt ? a - medAmt : medAmt - a) * 10n <= medAmt,
    ).length;
    if (okGaps * 4 < gaps.length * 3 || okAmts * 4 < amts.length * 3) continue;
    const last = g[g.length - 1] as LedgerTransaction;
    if (diffDays(asOf, last.bookingDate) > 2 * c.days) continue;
    const conf = Math.floor((okGaps * okAmts * 100) / (gaps.length * amts.length));
    let rrule: string =
      c.name === 'weekly'
        ? 'FREQ=WEEKLY'
        : c.name === 'biweekly'
          ? 'FREQ=WEEKLY;INTERVAL=2'
          : 'FREQ=YEARLY';
    if (c.name === 'monthly' || c.name === 'quarterly') {
      const counts = new Map<number, number>();
      let day = 0;
      let bestN = 0;
      for (const t of g) {
        const d = parseDate(t.bookingDate).d;
        const n = (counts.get(d) ?? 0) + 1;
        counts.set(d, n);
        if (n >= bestN) {
          bestN = n;
          day = d;
        }
      }
      rrule = `FREQ=MONTHLY;${c.name === 'quarterly' ? 'INTERVAL=3;' : ''}BYMONTHDAY=${day}`;
    }
    const cur = (last.postings[0] as { amount: Money }).amount.currency;
    out.push({
      merchantId: last.merchantId ?? null,
      description: last.payee || last.description || '',
      kind: last.kind as 'expense' | 'income',
      amount: fromMinor(amts[amts.length - 1] as bigint, cur),
      rrule,
      cadence: c.name,
      lastDate: last.bookingDate,
      transactionIds: g.map((t) => t.id),
      confidence: (conf / 100).toFixed(2),
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.confidence) - Number(a.confidence) || a.description.localeCompare(b.description),
  );
}
