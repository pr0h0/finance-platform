// Forecasting engine (PLAN §44): pure functions over dated events. Implemented by the
// forecasting agent; must match apps/api/internal/forecasting via shared fixtures.
import type { Confidence, IsoDate, Money } from '@finplat/domain';

export interface ForecastEvent {
  date: IsoDate;
  accountId: string;
  amount: Money; // signed
  confidence: Confidence;
  source: 'planned' | 'recurring' | 'installment' | 'transfer' | 'goal';
  sourceId: string;
}

export interface ForecastDay {
  date: IsoDate;
  expected: Money;
  conservative: Money;
  optimistic: Money;
}
