# Planning, budgets, forecasting and analytics — definitions

Server modules: `apps/api/internal/{recurrence,planning,budgets,savings,forecasting,analytics,automation,notifications}`
plus the shared read layer `internal/analytics/fin` (dates, profile context, FX valuation, ledger
aggregation). The TypeScript engine (`packages/finance-engine`, `packages/forecasting`) implements the
same rules for local-only mode; shared fixtures live in `packages/test-fixtures/conformance`.

## Calendar dates and time zones
All planning dates are local calendar dates (`date`, `YYYY-MM-DD`). "Today" is the current date in the
profile's IANA time zone (`profiles.timezone`). Expansion never converts instants, so DST changes and
server time zones cannot move a due date.

## Recurrence (`recurrence/rrule.go`, Feature 34)
RFC 5545 subset: `FREQ` DAILY|WEEKLY|MONTHLY|YEARLY, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` (ordinals for
monthly / yearly+BYMONTH), `BYMONTHDAY` (negative = from month end), `BYMONTH`, `WKST=MO`.
- Month days past the end clamp to the last day, always computed from the anchor (Jan 31 → Feb 28/29 →
  Mar 31). Yearly Feb 29 → Feb 28 in common years.
- `COUNT`/`occurrenceCount` and `UNTIL`/`endDate`: the stricter wins; counted from the series start.
- Weekend handling `businessDayAdjustment`: none | previous (Fri) | next (Mon). No holiday calendar.
- The **nominal** rule date is the occurrence identity; the adjusted (or user-overridden) date is the due date.
- Exceptions: an occurrence can be `skipped`, moved (`dateOverride`) or re-priced (`amountOverride`)
  via `PUT /plans/{id}/occurrences/{nominalDate}`. Termination: `endDate`, `occurrenceCount`, installments.

## Plans, matching, subscriptions, installments (Features 26–38)
- A plan is one-off (no recurrence) or a series; only matches/skips/overrides are stored
  (`planned_occurrences`), everything else is expanded on read.
- **No double counting** (invariant 19): an occurrence `matched` to a transaction, `paid_manual` or
  `skipped` is *resolved* and never counted again by budgets ("planned"), forecasts or reminders. A
  transaction can satisfy at most one occurrence (unique index). Match suggestions score amount (exact /
  within the plan range / ±10%), date (≤ 7 days), account, merchant and category.
- Priorities: essential, high, normal, low (= deferrable), optional. Confidence: certain, expected,
  possible, speculative.
- Subscriptions own a billing plan. Annualized cost = price × occurrences per year (`recurrence.PerYear`:
  365-day year, 52 weeks, 4 per month for an un-ordinaled weekday in a monthly rule), rounded once
  half-up; monthly = annual / 12. A price change ends the old series the day before the first billing on/
  after `effectiveDate` and starts a superseding plan (`supersedesId`), so history keeps old prices.
  Cancelling ends the series at `cancelledAt`; pausing pauses the plan.
- Installments: `installmentTotal` caps the series; `installmentStart` > 1 means earlier installments were
  paid before tracking. Paid = matched + paid_manual; outstanding = remaining pending occurrences.
- Planned vs actual: actual = matched transaction amount; paid_manual = planned amount; pending and past
  due = 0; pending future = no actual yet.
- Annual plan: per-month scheduled amounts plus a smoothed allocation where items recurring less often
  than monthly (yearly, quarterly, one-off) are spread evenly over 12 months (exact largest remainder).

## Budgets (Features 39–46)
- Periods: weekly (7-day blocks from the start date), monthly/quarterly/yearly starting on
  `periodAnchorDay` (clamped to month length, e.g. salary on the 25th), custom (start..end).
- Allocation with `categoryId = null` is an overall limit for all spending; a category allocation includes
  its subcategories.
- **actual** = completed spending in the period (expense splits − refund splits). **planned** =
  pending, unmatched expense occurrences due in the period (when `includePlanned`). **remaining** =
  limit + rolloverIn − actual − planned. utilization = actual / (limit + rolloverIn); alert = highest
  threshold reached. Budgets never require allocating all income.
- Rollover on period close: leftover = limit + rolloverIn − actual; `carry_surplus` keeps a positive
  leftover, `carry_deficit` a negative one, `carry_both` either, `none` nothing. Stored as the next
  period's allocation `rolloverAmount`.
- Templates: `isTemplate` budgets are instantiated with `POST /budgets/{id}/instantiate`.

## Valuation policy (all modules)
Amounts in another currency are valued in the reporting currency (`?currency=`, default profile base
currency) with `exchangerates.Lookup` (the API's single rate policy): latest snapshot on or before the
date; legally fixed EUR/BAM always current; manual override > fixed > provider; inverse pairs; cross via
EUR. Conversion rounds once, half-up. **Historical flows use their booking-date rate; balances use the
rate of the valuation date; forecasts use today's rate for the whole horizon** (stated in assumptions).
A missing rate is never guessed: the amount is excluded, the pair/date is listed in `missingRates` and the
response has `complete: false`.

## Analytics (Features 54–65)
- spending = expense − refund splits; income = income splits. Transfers (incl. credit-card payments),
  fx, opening balances and adjustments are neither; excluded/void/deleted transactions never count.
- **Savings rate** = (income − spending) / income of the period; undefined (no `value`) when income is 0.
- Merchant analytics group by merchant id (aliases are merged into one merchant by the merchants module);
  transactions without a merchant group by normalized payee/description (lower case, digits removed).
- Net worth at each period end: assets (asset accounts) − liabilities (owed amount of liability
  accounts), for accounts with `includeInNetWorth`.
- Recurring costs: active recurring expense plans as monthly (amount) and annual (allocated) equivalents.
- Conversion fees: recorded `currency_conversions.fee_amount`; spreads hidden in bank rates are not estimated.
- Insights are fixed rules (category spike ≥ 25% and ≥ 50 units over the 3-month average, savings rate,
  forecast shortfall, bills in 7 days, recurring total, uncategorized count, budget alerts, missing rates).
- Anomalies: `large_for_category` (> 3× the category median of the previous 180 days, ≥ 5 points),
  `new_merchant_large` (first payment to a merchant in a year and > 2× the overall median, ≥ 10 points).
  Each has an explanation; dismissals are synced user state (`anomaly_dismissals`).
- Reports (`/reports/{monthly|quarterly|annual|custom}`): JSON, CSV (formula-injection safe), PDF
  (plain text, Helvetica/WinAnsi). Image export is a client-side chart export (web).

## Forecasting (Features 66–71)
Daily projection from today: starting balances (transactions booked up to today) + future-dated ledger
postings (certain) + pending plan occurrences (overdue up to 60 days are assumed today) + what-if
adjustments (certain). Default accounts: non-archived asset accounts with `includeInSafeToSpend`; a plan
without an account moves only the total.

| scenario | income counted | expenses counted | variable amounts |
|---|---|---|---|
| expected | certain, expected | certain, expected, possible | planned |
| conservative | certain | all | income min / expense max |
| optimistic | certain, expected, possible | certain, expected | income max / expense min |

Outputs: daily expected/conservative/optimistic totals with events, lowest (expected and conservative)
balance and date, shortfall runs per account and total (first negative day, lowest amount, last negative
day), expected month-end balance, safe-to-spend = lowest conservative balance until the day before the
next expected income (≤ 31 days) minus the reserve (`forecast.minimumReserve` profile setting or
`?reserve=`), floored at 0. What-if (`POST /forecasts/scenarios`) only reads. Long-term lists month ends
(≤ 360 months). Every response lists its assumptions; uncertain results are estimates.

## Goals and emergency fund (Features 72–75)
- saved = dedicated account balance, else startingAmount + contributions (withdrawals negative). Reaching
  the target completes the goal.
- requiredMonthly = remaining / whole months to targetDate (≥ 1), rounded up. estimatedCompletion: when
  planned transfers/income into the goal account cover the remaining amount (`basis: planned`), else the
  6-month average net contribution extrapolated (`basis: history`), else none. onTrack = estimate ≤ target date.
- Emergency fund: reserves = active emergency_fund goals, else liquid accounts (checking, savings, cash,
  wallet, prepaid); essential monthly = monthly equivalent of active essential recurring expense plans,
  else the 6-month average spending. monthsCovered = reserves / essential monthly (1 decimal).

## Automation (Features 76–80)
- Rules: all conditions must match (description/payee/counterparty text ops incl. RE2 regex ≤ 256 chars,
  absolute amount comparisons, account, merchant, direction); lower `priority` runs first;
  `stopProcessing` ends evaluation. Actions go through `ledger.Update` (audited, synced) and never touch
  transactions the user categorized unless `overwrite` is requested on an explicit apply. A rule
  application can be undone from the audit before-snapshots; transactions edited since are reported.
  `automation.ApplyRules(ctx, tx, profileID, ids)` is the hook for new transactions.
- Suggestions come only from the profile's own history (rules, same merchant, same normalized description,
  merchant name in description). Duplicate and recurring detection only suggest; nothing is merged.

## Notifications (Features 31, 43, 81)
`notifications.Generate` (background job every 15 minutes when `JOBS_ENABLED`, one instance via a
PostgreSQL advisory lock) creates in-app notifications per profile member, deduplicated by key: bill due
(within `reminderDaysBefore`, default 3), bill overdue (≤ 7 days), budget threshold, projected negative
balance (14 days), trial ending (3 days), unusual expense (7 days). Email/push channels are not sent yet.
