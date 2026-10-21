# Import template reference (schemaVersion 1)

A template maps a table (CSV, TSV, XLSX/XLS sheet, rows rebuilt from a text PDF, or OCR rows) to
normalized records. It is JSON data, validated by `validateTemplate()` (`packages/importer-sdk/src/template.ts`);
max 32 KB; unknown keys are errors. Stored server-side in `import_templates.definition`.

| key | type / default | meaning |
|---|---|---|
| `schemaVersion` | `1` (required) | template schema version |
| `id` | slug `[a-z0-9-]`, required | stable id |
| `name` | string, required | display name |
| `templateVersion` | `x.y.z`, `1.0.0` | bump when the mapping changes |
| `bank` | `{name, country?, bic?}` | optional bank info |
| `format` | `csv` \| `tsv` \| `xlsx` \| `pdf` | `xlsx` also reads legacy `.xls` |
| `encoding` | `auto` | `utf-8`, `utf-16le`, `utf-16be`, `windows-1250`, `iso-8859-2` (text formats) |
| `delimiter` | `auto` | `;` `,` `\t` `\|` (csv); TSV always uses tab |
| `quote` | `"` | `"`, `'` or `''` (no quoting) |
| `sheet` | first sheet | sheet name or 0-based index (xlsx) |
| `skipRows` | `0` | non-empty rows to skip before the header (bank title lines) |
| `header` | `true` | if `false`, every column reference must be a 0-based index |
| `columns` | object, required | see below |
| `dateFormat` | required | tokens `YYYY YY MM M DD D`, literals `. / - space`; a trailing time is ignored |
| `valueDateFormat` | = `dateFormat` | |
| `number` | `{decimalSeparator: '.'\|',', thousandsSeparator: ''\|'.'\|','\|' '\|"'"}` | |
| `amountSign` | `negative_is_debit` | or `positive_is_debit` (card statements) |
| `directionValues` | — | `{debit: [...], credit: [...]}` literal values of the `direction` column (case-insensitive); required when `direction` is mapped |
| `currency` | — | ISO code used when there is no currency column (else `accountCurrency`) |
| `skipInvalidRows` | `true` | rows whose date does not parse (footers, sub-totals, repeated headers) become warnings instead of errors |
| `detect` | — | `{headerIncludes?: string[], fileNameIncludes?: string[]}` hints for auto-selecting the template |

### `columns`
Each value is a header name (case-insensitive, trimmed, literal) or a 0-based column index.

| field | required | notes |
|---|---|---|
| `postingDate` | yes | |
| `description` | yes | one ref or an array (up to 5) joined with spaces |
| `amount` | one of `amount` or `debit`/`credit` | signed (see `amountSign`) or magnitude with `direction` |
| `debit`, `credit` | | separate columns; one must be non-zero per row, both filled is an error |
| `direction` | | needs `directionValues` |
| `valueDate`, `currency`, `reference`, `runningBalance`, `counterparty`, `accountRef`, `originalAmount`, `originalCurrency` | | optional |

Accepted amount spellings: `-1.234,56`, `1.234,56-`, `(1.234,56)`, `+12`. Amounts with more decimals
than the currency allows are errors (`amount_precision`), never rounded. Zero rows are skipped with a warning.

### Example
See `packages/test-fixtures/imports/templates/primjer-banka-csv.json` (fictional bank: Windows-1250,
`;`, two title rows, debit/credit columns, `1.234,56`).

### Spreadsheets and PDFs
Spreadsheet date cells are rendered in `dateFormat` and numeric cells with the template's decimal mark
before mapping, so one template works for typed and text cells. For PDFs, rows are rebuilt from text
positions (same baseline → one row; a gap wider than about one character height → a new cell).
