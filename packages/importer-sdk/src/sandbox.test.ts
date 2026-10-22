import { describe, expect, test } from 'bun:test';
import {
  type CustomAdapter,
  checkStatementBalance,
  inputFromBytes,
  sandboxedImporter,
  validateAdapter,
} from './index.ts';

const csv = 'date;text;amount\n2025-01-02;Kupovina Šećer;-12.50\n2025-01-03;Plata;1000\n';
const file = (s = csv) => inputFromBytes('stmt.csv', new TextEncoder().encode(s));
const adapter = (code: string, extra: Partial<CustomAdapter> = {}): CustomAdapter => ({
  id: 'my-bank',
  name: 'My bank',
  version: '1.0.0',
  format: 'csv',
  code,
  ...extra,
});
const good = `
function detect(input) { return input.head.startsWith('date;text;amount') ? 0.99 : 0; }
function parse(input) {
  const rows = input.text.trim().split('\\n').slice(1).map((l) => l.split(';'));
  return {
    records: rows.map(([d, t, a]) => ({ postingDate: d, description: t, amount: a, currency: 'BAM' })),
    statements: [{ openingBalance: '0.00', closingBalance: '987.50', currency: 'BAM' }],
  };
}`;
const limits = {
  timeoutMs: 300,
  memoryBytes: 8 * 1024 * 1024,
  maxInputBytes: 1024,
  maxOutputBytes: 64 * 1024,
};

describe('sandboxed custom adapters (Feature 112)', () => {
  test('parses through the sandbox and validates like a bundled importer', async () => {
    const imp = sandboxedImporter(adapter(good), limits);
    expect(imp.manifest.id).toBe('custom-my-bank');
    expect((await imp.detect(file())).confidence).toBe(0.9); // capped below bundled importers
    expect((await imp.detect(file('x'))).confidence).toBe(0);
    const r = await imp.parse(file(), {});
    expect(r.records.map((x) => [x.postingDate, x.direction, x.amount, x.description])).toEqual([
      ['2025-01-02', 'debit', '12.50', 'Kupovina Šećer'],
      ['2025-01-03', 'credit', '1000.00', 'Plata'],
    ]);
    expect(r.records[0]?.fingerprint).toMatch(/^fp1:/);
    expect(checkStatementBalance(r.statements[0] as never, r.records).status).toBe('balanced');
  });
  test('no host APIs: network, timers, modules and globals of the host are absent', async () => {
    for (const probe of [
      'fetch("https://example.com")',
      'new XMLHttpRequest()',
      'require("fs")',
      'document.title',
      'setTimeout(() => 0, 1)',
      'process.env',
      'Bun.file("/etc/passwd")',
    ]) {
      const imp = sandboxedImporter(
        adapter(`function parse() { ${probe}; return { records: [] }; }`),
        limits,
      );
      await expect(imp.parse(file(), {})).rejects.toThrow('is not defined');
    }
  });
  test('CPU, memory, input and output limits', async () => {
    const run = (code: string, s?: string) =>
      sandboxedImporter(adapter(code), limits).parse(file(s), {});
    await expect(run('function parse() { for (;;) {} }')).rejects.toThrow('CPU time');
    await expect(run('function parse() { let s = "x"; for (;;) s = s + s; }')).rejects.toThrow(
      'memory',
    );
    await expect(run(good, 'x'.repeat(2048))).rejects.toThrow('limited to 1024');
    await expect(
      run(
        'function parse() { return { records: [], warnings: [{ message: "x".repeat(400) }].concat(Array(400).fill({ message: "y".repeat(400) })) }; }',
      ),
    ).rejects.toThrow('size limit');
  });
  test('output must match the schema: bad rows become errors, bad shapes are rejected', async () => {
    const run = (ret: string) =>
      sandboxedImporter(adapter(`function parse() { return ${ret}; }`), limits).parse(file(), {});
    await expect(run('42')).rejects.toThrow('does not match');
    await expect(run('{ records: [], extra: 1 }')).rejects.toThrow('does not match');
    const r = await run(`{ records: [
      { postingDate: '2025-01-02', description: 'ok', amount: '1.5', currency: 'EUR' },
      { postingDate: '02.01.2025', description: 'bad date', amount: '1', currency: 'EUR' },
      { postingDate: '2025-01-02', description: 'float', amount: 1.5, currency: 'EUR' },
      { postingDate: '2025-01-02', description: 'precision', amount: '1.005', currency: 'EUR' },
      { postingDate: '2025-01-02', description: 'x', amount: '1', currency: 'EUR', evil: true },
    ] }`);
    expect(r.records.map((x) => x.amount)).toEqual(['1.50']);
    expect(r.errors.map((e) => [e.row, e.code])).toEqual([
      [2, 'adapter_invalid_record'],
      [3, 'adapter_invalid_record'],
      [4, 'amount_precision'],
      [5, 'adapter_invalid_record'],
    ]);
  });
  test('adapter definitions are validated', () => {
    expect(validateAdapter(adapter(good))).toEqual([]);
    expect(
      validateAdapter(adapter(good, { id: 'Bad Id', format: 'pdf', version: '1' })).length,
    ).toBe(3);
  });
});
