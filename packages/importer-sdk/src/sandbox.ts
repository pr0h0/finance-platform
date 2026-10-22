// Sandboxed custom code adapters (Feature 112, PLAN §24 plugin security).
// User-supplied adapter JS runs in QuickJS (WebAssembly) with nothing but the ECMAScript builtins:
// no fetch/XHR, no filesystem, no DOM, no host objects. The host passes the file as text, enforces a
// CPU deadline, a heap limit and an input size limit, and validates every returned row against the
// normalized-record schema (ResultBuilder) before anything reaches staging. Web callers run this
// inside the parse Web Worker, so a runaway adapter never blocks the page either.
//
// Adapter contract (plain script, no imports):
//   function parse(input) { // input = { fileName, text }
//     return { records: [{ postingDate, description, amount, currency, ... }], statements: [] };
//   }
//   function detect(input) { return 0.9; }   // optional, input = { fileName, head }
import { z } from 'zod';
import { decodeBytes } from './encoding.ts';
import { ImportError, readAll, readHead } from './input.ts';
import { ResultBuilder } from './records.ts';
import {
  type BankImporter,
  IMPORTER_SDK_VERSION,
  type ImporterManifest,
  SOURCE_FORMATS,
  type SourceFormat,
} from './types.ts';

/** Text formats a custom adapter may declare (it receives decoded text, never raw bytes). */
export const ADAPTER_FORMATS = SOURCE_FORMATS.filter(
  (f) => !['xlsx', 'xls', 'pdf', 'pdf_ocr'].includes(f),
) as SourceFormat[];

export interface CustomAdapter {
  /** Stable id; the importer id becomes `custom-<id>`. */
  id: string;
  name: string;
  version: string; // x.y.z
  format: SourceFormat;
  code: string;
}

export interface SandboxLimits {
  timeoutMs: number;
  memoryBytes: number;
  maxInputBytes: number;
  maxOutputBytes: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 3000,
  memoryBytes: 64 * 1024 * 1024,
  maxInputBytes: 5 * 1024 * 1024,
  maxOutputBytes: 32 * 1024 * 1024,
};

const MAX_CODE = 256 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validateAdapter(a: CustomAdapter): string[] {
  const errs: string[] = [];
  if (!ID_RE.test(a.id)) errs.push('id: lowercase letters, digits and dashes');
  if (!a.name.trim() || a.name.length > 200) errs.push('name: required, at most 200 characters');
  if (!/^\d+\.\d+\.\d+$/.test(a.version)) errs.push('version: x.y.z');
  if (!ADAPTER_FORMATS.includes(a.format))
    errs.push(`format: one of ${ADAPTER_FORMATS.join(', ')}`);
  if (!a.code.trim() || a.code.length > MAX_CODE) errs.push('code: required, at most 256 KB');
  return errs;
}

type QuickJS = Awaited<
  ReturnType<typeof import('quickjs-emscripten-core').newQuickJSWASMModuleFromVariant>
>;
let quickjs: Promise<QuickJS> | undefined;
/** QuickJS wasm (single-file build: the wasm is embedded, nothing is fetched). Loaded on first use. */
function loadQuickJS(): Promise<QuickJS> {
  quickjs ??= (async () => {
    const [core, variant] = await Promise.all([
      import('quickjs-emscripten-core'),
      import('@jitl/quickjs-singlefile-mjs-release-sync'),
    ]);
    return core.newQuickJSWASMModuleFromVariant(variant.default);
  })();
  return quickjs;
}

/**
 * Evaluate `code`, then call `fn(arg)` inside a fresh QuickJS runtime and return its result as
 * JSON-decoded data. Throws ImportError on timeout, memory exhaustion, adapter errors or bad output.
 */
export async function runInSandbox(
  code: string,
  fn: 'parse' | 'detect',
  arg: unknown,
  limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS,
): Promise<unknown> {
  const qjs = await loadQuickJS();
  const { shouldInterruptAfterDeadline } = await import('quickjs-emscripten-core');
  const rt = qjs.newRuntime();
  rt.setMemoryLimit(limits.memoryBytes);
  rt.setMaxStackSize(1024 * 1024);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));
  const vm = rt.newContext();
  try {
    const argJson = vm.newString(JSON.stringify(arg));
    vm.setProp(vm.global, '__finplatArg', argJson);
    argJson.dispose();
    const src = `${code}\n;(function(){ if (typeof ${fn} !== 'function') throw new Error('adapter does not define ${fn}()');
      const out = ${fn}(JSON.parse(globalThis.__finplatArg)); return JSON.stringify(out === undefined ? null : out); })()`;
    const res = vm.evalCode(src, 'adapter.js');
    if (res.error) {
      const e = vm.dump(res.error) as { name?: string; message?: string } | string;
      res.error.dispose();
      const msg = typeof e === 'string' ? e : `${e?.name ?? 'Error'}: ${e?.message ?? ''}`;
      if (/interrupted/i.test(msg))
        throw new ImportError(
          'adapter_timeout',
          `adapter exceeded ${limits.timeoutMs} ms of CPU time`,
        );
      if (/out of memory/i.test(msg))
        throw new ImportError('adapter_memory', 'adapter exceeded its memory limit');
      throw new ImportError('adapter_failed', `adapter error: ${msg.slice(0, 500)}`);
    }
    const out = vm.getString(res.value);
    res.value.dispose();
    if (out.length > limits.maxOutputBytes)
      throw new ImportError('adapter_output_too_large', 'adapter output exceeds the size limit');
    return JSON.parse(out);
  } finally {
    vm.dispose();
    rt.dispose();
  }
}

// Output schema: the adapter returns record drafts; ResultBuilder then checks currency/scale and
// computes fingerprints exactly as for bundled importers.
const str = (max: number) => z.string().max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const dec = z.string().regex(/^[-+]?\d+(\.\d+)?$/, 'decimal string');
const recordSchema = z
  .object({
    postingDate: date,
    valueDate: date.optional(),
    description: str(1000),
    amount: dec,
    direction: z.enum(['debit', 'credit']).optional(),
    currency: str(10),
    originalAmount: dec.optional(),
    originalCurrency: str(10).optional(),
    exchangeRate: dec.optional(),
    runningBalance: dec.optional(),
    bankReference: str(200).optional(),
    counterparty: str(500).optional(),
    accountRef: str(100).optional(),
    statementRef: str(100).optional(),
    raw: z.record(z.string().max(100), str(2000)).optional(),
  })
  .strict();
const statementSchema = z
  .object({
    ref: str(100).optional(),
    accountRef: str(100).optional(),
    periodStart: date.optional(),
    periodEnd: date.optional(),
    openingBalance: dec.optional(),
    closingBalance: dec.optional(),
    currency: str(10).optional(),
  })
  .strict();
const outputSchema = z
  .object({
    records: z.array(z.unknown()).max(200_000),
    statements: z.array(statementSchema).max(1000).optional(),
    warnings: z
      .array(z.object({ message: str(500) }).strict())
      .max(1000)
      .optional(),
  })
  .strict();

export function sandboxedImporter(
  a: CustomAdapter,
  limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS,
): BankImporter {
  const manifest: ImporterManifest = {
    id: `custom-${a.id}`,
    version: a.version,
    sdkVersion: IMPORTER_SDK_VERSION,
    name: a.name,
    formats: [a.format],
    status: 'beta',
    limits: { maxBytes: limits.maxInputBytes },
    limitations: [
      'User-supplied code run in a sandbox (no network, files or DOM); results are validated but not reviewed.',
    ],
  };
  return {
    manifest,
    async detect(input) {
      if (!/\bfunction\s+detect\s*\(/.test(a.code)) return { confidence: 0 };
      try {
        const head = decodeBytes(await readHead(input, 8192));
        const c = await runInSandbox(
          a.code,
          'detect',
          { fileName: input.fileName, head },
          {
            ...limits,
            timeoutMs: Math.min(limits.timeoutMs, 500),
          },
        );
        const n = typeof c === 'number' && Number.isFinite(c) ? Math.max(0, Math.min(c, 0.9)) : 0;
        return n > 0
          ? { confidence: n, format: a.format, reason: 'custom adapter' }
          : { confidence: 0 };
      } catch {
        return { confidence: 0 };
      }
    },
    async parse(input, ctx) {
      const bytes = await readAll(input, { ...ctx, maxBytes: limits.maxInputBytes });
      const out = new ResultBuilder(manifest, a.format, ctx);
      const parsed = outputSchema.safeParse(
        await runInSandbox(
          a.code,
          'parse',
          { fileName: input.fileName, text: decodeBytes(bytes, ctx.encoding) },
          limits,
        ),
      );
      if (!parsed.success)
        throw new ImportError(
          'adapter_output_invalid',
          `adapter output does not match the import schema: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`,
        );
      for (const s of parsed.data.statements ?? []) out.statements.push(s);
      for (const w of parsed.data.warnings ?? [])
        out.warnings.push({ code: 'adapter_warning', message: w.message });
      parsed.data.records.forEach((x, i) => {
        const row = i + 1;
        const r = recordSchema.safeParse(x);
        if (!r.success) {
          const iss = r.error.issues[0];
          out.errors.push({
            row,
            field: iss?.path.join('.'),
            code: 'adapter_invalid_record',
            message: `${iss?.path.join('.') || 'record'}: ${iss?.message}`,
          });
          return;
        }
        const { amount, direction, raw, ...rest } = r.data;
        out.add({
          ...rest,
          rowNumber: row,
          ...(direction ? { amount, direction } : { signedAmount: amount }),
          raw: raw ?? { description: rest.description, amount, postingDate: rest.postingDate },
          confidence: 0.9,
        });
      });
      return out.finish();
    },
  };
}
