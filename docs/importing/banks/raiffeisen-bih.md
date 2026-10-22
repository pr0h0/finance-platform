# Raiffeisen Bank BiH — PDF statement ("IZVOD - OBAVIJEST")

Importer id `raiffeisen-bih` (v1.0.0, status `beta`), code in
`packages/bank-importers/src/banks/raiffeisen-bih/`. PDF parsing needs pdfjs, so it runs in the web client
(parse worker); the server lists it as client-only (`serverSide: false`) and stages the normalized result
the client uploads. A multipart upload asking the server to parse it gets `422 client_parse_required`.

The layout was learned from real statements kept locally (never committed). Tests use a synthetic PDF
(`packages/test-fixtures/imports/raiffeisen-bih/izvod-synthetic.pdf`) produced by
`BUN_WORKDIR=packages/bank-importers scripts/bun.sh scripts/generate-raiffeisen-fixtures.ts`; every name,
account, IBAN and amount in it is invented.

## Layout
- Text-layer PDF, A4, Helvetica-like font, no Bosnian diacritics in most labels (`Racun`, `Pocetno`); transaction
  descriptions are plain ASCII (`č/ć`→`c`, `š`→`s`, `ž`→`z`, `đ`→`d`/`dj`), so merchant templates fold
  diacritics before matching.
- **Header (page 1)**: holder name and address (ignored); block "Podaci o racunu" with `Racun:` (local
  account number), `IBAN:` and `Proizvod:` (product), each value printed under its label; block
  "Pregled stanja racuna" with three columns `Pocetno stanje:` (opening), `Odobreni limit:` (credit limit,
  ignored) and `Konacno stanje:` (closing); title `IZVOD - OBAVIJEST` and `period od: DD/MM/YYYY do: DD/MM/YYYY`.
- **Table** (may start on page 2; the header repeats on each page that has rows):

  | column | meaning | mapped to |
  |---|---|---|
  | Datum obrade | booking date | `postingDate` |
  | Datum transakcije | card/transaction date (can precede the period) | `valueDate` |
  | Opis transakcije | description, wrapped onto 1–3 lines | `description` (lines joined top to bottom) |
  | Valuta | currency of the original transaction | `originalCurrency` when not the account currency |
  | Iznos transakcije u valuti | original amount, `0.00` for domestic rows | `originalAmount` |
  | Iznos transakcije u KM | signed amount in the account currency | `amount` + `direction` |
  | Saldo | running balance after the row | `runningBalance` |

- Numbers: `1,234.56` (comma thousands, dot decimal, leading minus). Dates `DD/MM/YYYY`.
- Wrapped descriptions are vertically centred on the amounts row: lines are printed above and below the
  row's baseline. The importer assigns each description-column line that is not itself a row to the nearest
  row on the same page (within 12 pt), so descriptions stay whole.
- Foreign card payments usually appear as two rows (the converted amount and a separate fee row in KM).
- Rows are in bank processing order, not strictly by date; running balances follow file order.
- After the table: a `...` marker, an "unpaid fees and interest" summary (not imported: it lists fees not yet
  charged, which are not movements of this statement), a repeat of limit / closing / available balance, and an Info
  section with the bank name (used for detection).
- No transaction references or counterparties are printed.

## Checks
- Detection: `%PDF` + text containing `IZVOD - OBAVIJEST`, `Pregled stanja racuna`, `Opis transakcije`
  and `Raiffeisen` → confidence 0.95 (above the generic PDF template importer).
- One `StatementInfo` per file: `ref = <account>:<periodStart>..<periodEnd>`, `accountRef` = IBAN,
  opening/closing balances and currency from the "KM" column label. The import wizard verifies
  opening + Σ amounts = closing and every printed running balance; coverage uses the statement period.
- Rows that do not have two dates, a currency and three amounts become `unparsable_row` errors.
- Account currency other than KM has not been seen; the column label is read and normalized, so a
  different ISO code would be used as printed.
