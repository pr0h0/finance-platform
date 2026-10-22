# Importing — overview and contributor guide

Client-side import framework (PLAN §23–25). Code lives in two TS packages:

| package | contents |
|---|---|
| `packages/importer-sdk` | contract (`BankImporter`, `ImportInput`, `ImportResult`, `NormalizedRecord`), streaming input + encoding detection, streaming CSV, date/amount parsing, declarative template schema + engine, `fp1` fingerprint, reconciliation, coverage, registry |
| `packages/bank-importers` | bundled importers (CSV, TSV, XLSX, XLS, OFX, QFX, QIF, CAMT.053, CAMT.054, MT940, JSON, text PDF, OCR) and `banks/<bank>/` adapters. `createRegistry()` returns all of them |

Related docs: [fingerprint.md](fingerprint.md) (normative, shared with Go), [templates.md](templates.md)
(template reference), [formats.md](formats.md) (what each importer supports and its limits).

## Using it

```ts
import { inputFromBlob, matchExisting, checkStatementBalance, coverageSources, totals } from '@finplat/importer-sdk';
import { createRegistry } from '@finplat/bank-importers';

const reg = createRegistry();
const input = inputFromBlob(file);                 // browser File; nothing is read yet
const [best] = await reg.detect(input);            // ranked candidates
const result = await reg.require(best.importer.id).parse(input, { template, accountCurrency: 'BAM' });
// result.records: NormalizedRecord[] (amount = positive decimal string at currency scale + direction)
// result.errors / result.warnings: per-row issues; result.confidence; result.requiresApproval (OCR)
```

Workflow helpers: `totals()` (income/expense per currency), `checkStatementBalance()` (opening + Σ =
closing), `checkRunningBalances()` (printed balances, either row order, derived opening balance),
`matchExisting()` (duplicate / conflict / matched / new against saved rows), `coverageSources()` +
`computeCoverage()` + `monthlyCoverage()` (complete / partial / missing / unverified / conflicting).
Mapping editor: `readTablePreview()` and `suggestTemplate()`; validate with `validateTemplate()`.

Money is never a JS number: amounts are parsed as text and normalised with `@finplat/finance-engine`
(exact bigint). The only float→text conversion is for spreadsheet number cells (`excelNumberText`,
15 significant digits = Excel's own precision).

## Streaming and memory
CSV, TSV, QIF and MT940 are decoded and parsed chunk by chunk from `ImportInput.stream()` (Web Streams),
so file size is bounded only by the row limit (`maxRows`, default 200 000).
CAMT.053/054 and OFX/QFX are parsed by an incremental SAX-style tokenizer (`MarkupStream` in
`formats/markup.ts`): each `Ntry` / `STMTTRN` becomes a record when its element closes and is then dropped
from the tree, so memory holds one entry plus the statement headers; they keep the `maxBytes` cap
(default 50 MB) as a guard against documents with huge non-entry content.
JSON, XLSX/XLS and PDF still need the whole file and are capped by `maxBytes` (30 MB for spreadsheets/PDF).
Server (Go): uploads are read whole (they are hashed and stored as evidence, `MAX_UPLOAD_BYTES`); CAMT is
decoded with an `encoding/xml` token stream (one `Ntry` struct at a time); OFX, QIF, MT940 and JSON build
their structures from the whole file. Normalized records are kept in memory for the preview.

## Security rules (PLAN §24)
- Only reviewed importers bundled in `packages/bank-importers` are registered. End users extend the system
  with **templates** (data) or, when a format needs code, **custom code adapters** (below).
- Templates are validated with a strict zod schema: unknown keys are rejected, there are no regexes,
  expressions or code; header names are matched literally; date formats use a fixed token set.
- XML: DTDs/DOCTYPE are rejected (no XXE, no entity expansion), only predefined + numeric entities.
- PDF: pdfjs with font faces, system fonts and XFA disabled. Spreadsheets: SheetJS 0.20.3 (patched
  for CVE-2023-30533 / ReDoS), formulas never recalculated.
- Parsers do no network or storage I/O. The OCR importer lazily loads tesseract.js and its
  language data — the only network use, and only when the user picks OCR.

## Custom code adapters (Feature 112)
User JavaScript for a text format (`csv`, `tsv`, `ofx`, `qfx`, `qif`, `camt053`, `camt054`, `mt940`, `json`),
managed in Import center → Custom adapters. A plain script defines `parse({ fileName, text })` returning
`{ records, statements?, warnings? }` and optionally `detect({ fileName, head })` returning 0..1.
- **Sandbox**: `sandboxedImporter()` (`packages/importer-sdk/src/sandbox.ts`) runs the code in QuickJS
  compiled to WebAssembly (`quickjs-emscripten-core` + the single-file variant, nothing fetched), inside the
  parse Web Worker. The VM has only ECMAScript builtins: no `fetch`/XHR, no timers, no modules, no
  filesystem, no DOM, no access to the ledger. Limits: 3 s CPU (interrupt handler), 64 MB heap, 5 MB input,
  32 MB output; the page also terminates the worker if it does not answer in time.
- **Output validation**: strict zod schema (unknown keys rejected, amounts must be decimal strings, dates
  `YYYY-MM-DD`), then `ResultBuilder` (currency, scale, zero rows, fingerprints) like bundled importers.
  Invalid rows become errors; a malformed result is rejected.
- **Permission**: an adapter runs only after the user ticks the grant in the editor; the grant stores the
  SHA-256 of the code, so editing the code revokes it. Adapters are stored only on this device, per
  profile (localStorage), never synced or uploaded. Importer id `custom-<id>`; the server accepts its
  client-parsed result like any client-only importer.
- Custom adapters are not used by auto-detect; pick them in the importer list.

## Writing a bank adapter
1. Prefer a **template** (`packages/test-fixtures/imports/templates/*.json` shows examples). Write code
   only if the format cannot be expressed declaratively.
2. Code adapter: `packages/bank-importers/src/banks/<bank-id>/index.ts` exporting a `BankImporter`
   (`manifest` with `id`, semver `version`, `sdkVersion: IMPORTER_SDK_VERSION`, `formats`, `status`,
   `limitations`). Build records through `ResultBuilder.add()` so currency/scale validation and
   fingerprints are uniform. Register it in `src/index.ts`.
3. Never commit real statements. Add **synthetic** fixtures under
   `packages/test-fixtures/imports/<bank-id>/` (regenerate binary ones from a script, see
   `packages/bank-importers/scripts/generate-fixtures.ts`).
4. Required tests (see `src/importers.test.ts` for patterns): parser, error rows, duplicate import
   (overlapping files → `matchExisting` says duplicate), encoding (each code page the bank uses),
   date parsing (incl. month/year boundaries), currency (unknown currency, scale/precision).
5. Bump `version` on any behaviour change: it is stored on every raw record, and reprocessing
   (Feature 130) compares versions.
6. Run `scripts/bun.sh test packages/bank-importers packages/importer-sdk` and `scripts/bun.sh run lint`.

Raiffeisen Bank BiH (PDF statement) is implemented as a code adapter: see `docs/importing/banks/raiffeisen-bih.md`.

## Commands
```sh
scripts/bun.sh test packages/importer-sdk packages/bank-importers
BUN_WORKDIR=packages/bank-importers scripts/bun.sh scripts/generate-fixtures.ts   # binary fixtures
BUN_WORKDIR=packages/importer-sdk scripts/bun.sh scripts/fp-vectors.ts            # fp1 vectors
```
