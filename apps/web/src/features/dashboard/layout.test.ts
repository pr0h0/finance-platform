import { expect, test } from 'bun:test';
import { defaultLayout, moveWidget, normalizeLayout, toggleWidget, WIDGETS } from './layout.ts';

test('normalizeLayout keeps saved order, drops unknown ids, appends new widgets', () => {
  const l = normalizeLayout({
    order: ['goals', 'bogus', 'goals', 'recent'],
    hidden: ['x', 'recent'],
  });
  expect(l.order.slice(0, 2)).toEqual(['goals', 'recent']);
  expect(l.order.length).toBe(WIDGETS.length);
  expect(new Set(l.order).size).toBe(WIDGETS.length);
  expect(l.hidden).toEqual(['recent']);
  expect(normalizeLayout(null)).toEqual(defaultLayout());
});

test('moveWidget and toggleWidget', () => {
  const l = moveWidget(defaultLayout(), 'sync-health', 0);
  expect(l.order[0]).toBe('sync-health');
  expect(moveWidget(l, 'sync-health', 999).order.at(-1)).toBe('sync-health');
  const h = toggleWidget(l, 'goals');
  expect(h.hidden).toEqual(['goals']);
  expect(toggleWidget(h, 'goals').hidden).toEqual([]);
});
