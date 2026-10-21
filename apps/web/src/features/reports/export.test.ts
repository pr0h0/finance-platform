import { expect, test } from 'bun:test';
import { csvCell, toCsv } from './export.ts';

test('csv quoting and formula-injection guard', () => {
  expect(csvCell('a,b')).toBe('"a,b"');
  expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
  expect(csvCell('@cmd')).toBe("'@cmd");
  expect(csvCell('-12.50')).toBe('-12.50');
  expect(csvCell(null)).toBe('');
  expect(
    toCsv([
      ['a', 1],
      ['b', '2'],
    ]),
  ).toBe('a,1\r\nb,2\r\n');
});
