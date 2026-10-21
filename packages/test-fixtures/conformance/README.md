# Conformance fixtures

Shared input → expected-output cases that BOTH implementations must pass:
- TypeScript: `packages/finance-engine/src/conformance.test.ts`
- Go: `apps/api/internal/money/conformance_test.go`

Add a case here whenever you fix a money bug; never special-case one side.
Rounding modes: half_up (half away from zero), half_even (banker's), down (toward zero),
up (away from zero), floor, ceiling. `rate` in fx.json means units of `to` per 1 `from`;
`inverse: true` means the rate is quoted as units of `from` per 1 `to` (amount / rate).
