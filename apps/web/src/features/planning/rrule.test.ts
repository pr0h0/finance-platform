import { expect, test } from 'bun:test';
import { buildRRule, describeRRule, emptyRecurrence, parseRecurrence } from './rrule.ts';

test('build and parse round trip', () => {
  expect(buildRRule(emptyRecurrence())).toBeNull();
  const w = { freq: 'WEEKLY' as const, interval: 2, byDay: ['FR', 'MO'], byMonthDay: null };
  expect(buildRRule(w)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR');
  expect(parseRecurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR')).toEqual({
    ...w,
    byDay: ['MO', 'FR'],
  });
  const m = parseRecurrence('FREQ=MONTHLY;BYMONTHDAY=-1');
  expect(m.byMonthDay).toBe(-1);
  expect(m.custom).toBeUndefined();
  expect(parseRecurrence('FREQ=MONTHLY;BYDAY=1MO').custom).toBe('FREQ=MONTHLY;BYDAY=1MO');
  expect(describeRRule('FREQ=MONTHLY;BYMONTHDAY=-1')).toBe('Every month on day last');
  expect(() => buildRRule({ freq: 'MONTHLY', interval: 1, byDay: [], byMonthDay: 40 })).toThrow();
});
