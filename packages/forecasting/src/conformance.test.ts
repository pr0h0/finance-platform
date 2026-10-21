// Runner for packages/test-fixtures/conformance/forecast.json (Go: apps/api/internal/conformance_test).
import { describe, expect, test } from 'bun:test';
import {
  createRateBook,
  type PlanLike,
  type RateSnapshot,
  reportingConverter,
  type ScheduleLike,
  type StoredOccurrence,
} from '@finplat/finance-engine';
import { loadConformance } from '@finplat/test-fixtures';
import { eventsFromPlans, type ForecastInput, forecast } from './index.ts';

const fx = loadConformance<{
  rates: RateSnapshot[];
  cases: { name: string; op: 'forecast' | 'planEvents'; input: unknown; expected: unknown }[];
}>('forecast');
const book = createRateBook(fx.rates);

describe('conformance: forecast', () => {
  for (const c of fx.cases) {
    test(c.name, () => {
      if (c.op === 'planEvents') {
        const i = c.input as {
          plans: PlanLike[];
          schedules: ScheduleLike[];
          stored: StoredOccurrence[];
          from: string;
          to: string;
        };
        const r = eventsFromPlans(i.plans, i.schedules, i.stored, i.from, i.to);
        expect(r.warnings).toEqual([]);
        expect(r.events).toEqual(c.expected as never);
        return;
      }
      const input = c.input as Omit<ForecastInput, 'convert'>;
      const f = forecast({ ...input, convert: reportingConverter(book, input.currency) });
      const e = c.expected as {
        days: { date: string }[];
        [k: string]: unknown;
      };
      const { days, ...rest } = e;
      expect({
        lowest: f.lowest,
        shortfalls: f.shortfalls,
        monthEnd: f.monthEnd,
        safeToSpend: f.safeToSpend,
        complete: f.complete,
      }).toEqual(rest as never);
      for (const d of days) {
        const got = f.days.find((x) => x.date === d.date);
        expect(
          got && {
            date: got.date,
            expected: got.expected,
            conservative: got.conservative,
            optimistic: got.optimistic,
          },
        ).toEqual(d as never);
      }
    });
  }
});
