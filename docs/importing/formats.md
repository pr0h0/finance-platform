# Supported formats and limitations

| importer id | formats | status | streams | notes / limitations |
|---|---|---|---|---|
| `generic-csv` | csv | stable | yes | needs a template |
| `generic-tsv` | tsv | stable | yes | needs a template |
| `generic-xlsx` | xlsx | stable | no (30 MB) | needs a template; cached formula values only |
| `generic-xls` | xls | beta | no (30 MB) | BIFF via SheetJS; no password-protected files |
| `generic-ofx` / `generic-qfx` | ofx, qfx | stable | tokenized (50 MB cap) | OFX 1.x SGML + 2.x XML, bank + credit card; investment statements ignored; only LEDGERBAL (closing) is available so the statement is "unverifiable" |
| `generic-qif` | qif | stable | yes | needs `accountCurrency`; day/month order inferred from the whole file (warning when ambiguous); splits kept in raw only |
| `generic-camt053` / `generic-camt054` | camt053, camt054 | stable | tokenized (50 MB cap) | any version; OPBD/PRCD and CLBD balances; PDNG entries skipped; batched entries → one record; reversals flip direction |
| `generic-mt940` | mt940 | stable | yes | SWIFT envelope tolerated; `:86:` used verbatim (bank-specific sub-fields are not split) |
| `generic-json` | json | stable | no | finplat interchange shape below |
| `generic-pdf-text` | pdf | beta | no (30 MB) | text-layer PDFs only; needs a template; multi-line descriptions keep their first line |
| `generic-ocr` | pdf_ocr | beta | no (20 MB) | optional tesseract.js, lazy loaded (language data downloaded on first use); scanned PDFs need a browser (OffscreenCanvas); every record confidence ≤ 0.6 and `requiresApproval` — the user must confirm values. Not exercised by automated tests (needs network + images) |
| `raiffeisen-bih` | pdf | beta | client only | Raiffeisen BiH "IZVOD - OBAVIJEST" PDF; wrapped descriptions kept whole; see banks/raiffeisen-bih.md |

Encodings (text formats): UTF-8 (with/without BOM), UTF-16 with BOM, Windows-1250, ISO-8859-2.
Detection: BOM → valid UTF-8 → bytes 0x80–0x9F mean Windows-1250 → Š/Ž/š/ž positions of ISO-8859-2 →
Windows-1250 (lower confidence). Override with `ImportContext.encoding` or the template `encoding`.

Dates are taken as printed (`YYYY-MM-DD`), never shifted by time zone; datetime values keep their date part.

## finplat JSON interchange
```json
{
  "format": "finplat-import", "version": 1,
  "statements": [{ "ref": "S1", "accountRef": "…", "periodStart": "2025-04-01", "periodEnd": "2025-04-30",
                   "openingBalance": "100.00", "closingBalance": "80.01", "currency": "EUR" }],
  "transactions": [{ "postingDate": "2025-04-02", "amount": "-20.00", "currency": "EUR", "description": "Books",
                     "reference": "T1", "valueDate": "…", "counterparty": "…", "accountRef": "…", "statementRef": "S1",
                     "runningBalance": "…", "originalAmount": "…", "originalCurrency": "…", "exchangeRate": "…" }]
}
```
A bare array of transactions is also accepted. `amount` is a signed decimal **string**; JSON numbers are rejected.
