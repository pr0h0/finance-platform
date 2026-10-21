# 0002 — Money representation

Status: accepted (Phase 0)

## Decision
**Wire / storage / domain representation (the only one):**

```json
{ "amount": "150.00", "currency": "BAM" }
```

- `amount` is a decimal string matching `^-?\d+(\.\d+)?$` with **exactly** the ISO 4217 minor-unit scale of
  `currency` once normalized (`"1.5"` BAM → `"1.50"`; `"1.505"` EUR is rejected; `"100"` JPY; `"0.125"` KWD).
  Trailing zeros beyond the scale are accepted on input and dropped.
- Never a JSON number, never a float, anywhere.
- PostgreSQL: `NUMERIC(30,10)` amount column + `char(3)` currency column. Exchange rates `NUMERIC(38,18)`.
- Scales: `packages/finance-engine/src/currencies.ts` ≡ `apps/api/internal/money/currencies.go` ≡ seeded
  `currencies` table. EUR/BAM is fixed at **1.95583** (currency board), seeded as a `fixed` rate.

**Arithmetic:** integer minor units in `bigint` (TS) / `*big.Int` (Go). No decimal library: the operations
needed (add, sub, multiply by decimal factor, divide by rate, allocate) are short and exact with integers,
and identical algorithms on both sides make conformance trivial.

**Rounding** happens only at accounting boundaries (conversion result, allocation, multiplication result),
exactly once, with an explicit mode:

| mode | meaning |
|---|---|
| `half_up` (default) | half away from zero (commercial rounding; EU euro-conversion rule) |
| `half_even` | banker's rounding |
| `down` / `up` | toward / away from zero |
| `floor` / `ceiling` | toward −∞ / +∞ |

**Conversion:** `convert(m, to, rate)` = amount × rate where rate = units of `to` per 1 unit of source;
`convertInverse(m, to, rate)` = amount ÷ rate for rates quoted the other way (BAM→EUR with 1.95583). Both
compute the exact rational and round once to the target scale.

**Allocation:** largest-remainder method; parts always sum exactly to the total; ties to the lower index;
negative totals allocated by magnitude.

**Conformance:** `packages/test-fixtures/conformance/*.json` is run by
`packages/finance-engine/src/conformance.test.ts` and `apps/api/internal/money/conformance_test.go`.
Every money bug fix adds a fixture.

## APIs
- TS: `import { money, add, subtract, sum, multiply, convert, convertInverse, allocate, splitEvenly,
  toMinor, fromMinor, roundDecimal, balances, splitsBalance } from '@finplat/finance-engine'`.
- Go: `money.Parse(amount, cur)`, `MustParse`, `FromMinor`, `FromNumeric(pgtype.Numeric, cur)`,
  `m.Numeric()`, `m.Amount()`, `Add/Sub/Neg/Abs/Cmp`, `Sum`, `Multiply`, `Convert`, `ConvertInverse`,
  `Allocate`, `Balances`, `SplitsBalance`, `RoundDecimal`, `DivRound`. JSON marshals to the wire shape.

## Consequences
Display formatting uses `Intl.NumberFormat` with the decimal string (`@finplat/currency.formatMoney`).
Aggregations in SQL are allowed (`SUM(numeric)` is exact) but results must go through `money.FromNumeric`.
