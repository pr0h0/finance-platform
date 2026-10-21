# Conformance fixtures

Shared input → expected-output cases that BOTH implementations must pass:
- TypeScript: `packages/finance-engine/src/conformance.test.ts`
- Go: `apps/api/internal/money/conformance_test.go`

Add a case here whenever you fix a money bug; never special-case one side.
Rounding modes: half_up (half away from zero), half_even (banker's), down (toward zero),
up (away from zero), floor, ceiling. `rate` in fx.json means units of `to` per 1 `from`;
`inverse: true` means the rate is quoted as units of `from` per 1 `to` (amount / rate).

## Engine fixtures (finance-engine / forecasting)
Runners: `packages/finance-engine/src/engine-conformance.test.ts`, `packages/forecasting/src/conformance.test.ts`
and Go `apps/api/internal/conformance_test` (families without an exported Go function are skipped with the
function they wait for). Rules are documented at the top of each TS module.

| file | TS | Go |
|---|---|---|
| `recurrence.json` | `expandRecurrence` (recurrence.ts) | `recurrence.Expand` |
| `subscriptions.json` | `perYear` / `annualize` (plans.ts) | `recurrence.PerYear` + `fin.MulRat` |
| `fx_lookup.json` | `createRateBook().resolve` + `convertResolved` (fx.ts) | `exchangerates.Lookup`, `fin.Converter` |
| `aggregation.json` | `byCategory`, `byMerchant`, `cashflow`, `accountBalances`, `netWorth`, `savingsRate` (analytics.ts) | pending |
| `budgets.json` | `budgetPeriods`, `budgetStatus` (budgets.ts) | pending |
| `forecast.json` | `forecast`, `eventsFromPlans` (forecasting) | pending |

`aggregation.json`/`budgets.json` share one transaction set per file; transactions use the API `Transaction`
shape (postings + splits). Rates are `ExchangeRate` snapshots (`1 base = rate quote`); EUR/BAM is always the
fixed 1.95583 parity. Expected `warnings` strings are not compared.
