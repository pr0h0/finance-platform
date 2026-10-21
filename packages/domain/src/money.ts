/**
 * Authoritative money representation (ADR 0002): a decimal string with exactly the currency's
 * minor-unit scale plus an ISO 4217 code. {amount: "150.00", currency: "BAM"}.
 * Never use JS numbers for money. Arithmetic lives in @finplat/finance-engine.
 */
export type Decimal = string;
export interface Money {
  amount: Decimal;
  currency: string;
}
