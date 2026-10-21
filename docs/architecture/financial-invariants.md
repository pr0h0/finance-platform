# Financial invariants

Every module must preserve these. Each has (or must get) an automated test; the test file is listed when it
exists.

## Money
1. No binary floats for money anywhere (DB, Go, TS, JSON). Wire = `{amount: decimal string, currency}` (ADR 0002).
2. Amount scale = currency minor units; more precision is rejected, not rounded. (conformance/money_parse)
3. Rounding only at defined boundaries, once, with an explicit mode; default `half_up`. (conformance/rounding, fx)
4. Arithmetic across currencies is an error unless converted with an explicit rate snapshot.
5. EUR/BAM uses the fixed 1.95583 rate.
5a. Valuation policy (`exchangerates.Lookup`): the snapshot with the latest `rate_date` on or before the date
   wins (direct, inverse, else cross via EUR); fixed rates are always current; same date: profile manual >
   fixed > provider. Snapshots are never updated in place; recorded fx transactions keep the rate they used
   (`currency_conversions`). (transactions/api_test.go TestCriticalFXRoundingAndHistoricalRates, conformance fx_lookup)

## Ledger
6. Account balance = sum of its non-deleted postings of non-deleted, non-void transactions. Caches
   (`financial_snapshots`) are never authoritative. (conformance/balance)
7. Postings are immutable (DB trigger). (internal/changes TestImmutabilityTriggers)
8. Same-currency `transfer`: postings sum to zero. `fx`: one negative and one positive posting in different
   currencies plus a `currency_conversions` row.
9. Transfers, fx, opening balances and adjustments never count as income or expense; credit-card payments
   are transfers, so card purchases count once.
10. Refunds reduce spending in the refunded categories; they are not income.
11. Splits: positive amounts, same currency as the posting, sum exactly to |posting| (conformance/splits);
    the parent transaction is never counted in addition to its splits. Editing split categories or
    descriptions never changes balances.
12. Bulk operations and sync merges must leave every transaction's splits balanced, or fail as a whole.

## Evidence & imports
13. Imported raw records are never updated (DB trigger). User interpretation lives on transactions.
14. Re-importing the same rows is detected by `dedupe_fingerprint` and does not duplicate transactions
    (unique `transactions.import_record_id`).
15. Rolling back a batch removes only transactions created by that batch.
16. Reprocessing preserves user categories/notes/splits.

## Dates
17. `booking_date`, `value_date`, `due_date`, recurrence dates are local calendar dates (`date`), never
    derived from server time or shifted by a timezone change. Instants are UTC `timestamptz`. (TestImmutabilityTriggers asserts no shift)
18. Recurrence on day 29–31 clamps to month end (documented in recurrence module); business-day adjustment
    is explicit.

## Planning & forecasting
19. A planned occurrence matched to a transaction is never counted again in budgets or forecasts.
20. Budgets report actual and planned separately.
21. Forecasts are daily over dated events, expose the lowest balance and its date, and list assumptions.

## Sync, audit, authorization
22. Every mutation of a syncable entity goes through `changes.Record` in the same DB transaction.
23. Money-bearing fields are never resolved by last-write-wins (sync-protocol.md).
24. Every financial query filters by `profile_id` and the caller passed `authz.RequireProfile`.
25. MCP clients are read-only unless granted; writes respect approval rules enforced server-side.
