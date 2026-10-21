# Import dedup fingerprint — `fp1` (normative)

Shared contract between the TS importer SDK (`packages/importer-sdk/src/fingerprint.ts`) and the Go
imports module (`apps/api/internal/imports`). Both MUST produce byte-identical strings. The shared test
vectors live in `packages/test-fixtures/imports/fingerprint.json`; both runners must pass them.

Stored in `imported_raw_records.dedupe_fingerprint`. Duplicate lookup is
`WHERE profile_id = $1 AND account_id = $2 AND dedupe_fingerprint = ANY($3)` — the fingerprint
deliberately does **not** contain the account, because the same account appears with different
identifiers in different formats (IBAN in CAMT, local number in CSV). Scope by `account_id` instead.

## Inputs (per normalized record)

| field | source |
|---|---|
| `postingDate` | `YYYY-MM-DD` as printed by the bank (never timezone-shifted) |
| `amount` | positive decimal string magnitude |
| `direction` | `debit` or `credit` |
| `currency` | ISO 4217 code |
| `bankReference` | bank transaction reference, may be empty |
| `description` | source description, may be empty |

## Canonicalization

1. **date**: the `YYYY-MM-DD` string unchanged.
2. **amount**: signed decimal, `-` for debit, none for credit. Strip trailing zeros of the fraction,
   then a trailing `.`; strip leading zeros of the integer part (keep one `0`). Zero is `0` (never `-0`).
   Examples: debit `150.00` → `-150`; credit `0.50` → `0.5`; credit `1200.10` → `1200.1`; `0.00` → `0`.
3. **currency**: uppercase.
4. **reference**: trim, remove all Unicode whitespace, uppercase. If the result is one of the
   placeholders `NONREF`, `NOTPROVIDED`, `N/A`, `NA`, `-`, `0` it is treated as empty.
5. **description**: Unicode NFKC, then lowercase (JS `toLowerCase()`, Go `strings.ToLower`), then keep
   only code points that are letters or numbers (JS `/[\p{L}\p{N}]/u`, Go `unicode.IsLetter || unicode.IsNumber`);
   everything else (spaces, punctuation, combining marks) is dropped.
6. **key**: if the canonical reference is non-empty → `keyKind = "ref"`, `keyValue = reference`;
   otherwise `keyKind = "desc"`, `keyValue = canonical description`.
   (References are preferred because descriptions are often truncated differently between formats.)

## Occurrence ordinal

Two genuinely identical rows (two coffees, same day, same amount, no reference) must not collapse into
one. Within **one parse result for one account**, group records by
`date, amount, currency, keyKind, keyValue` and number each group's members `1, 2, 3, …` in file order.
Overlapping statements produce the same ordinals for the same real-world rows, so cross-file dedup still works.

## Hash

```
payload     = join(["fp1", date, amount, currency, keyKind, keyValue, ordinal], "\x1f")   # U+001F unit separator
fingerprint = "fp1:" + lowercase_hex(sha256(utf8(payload)))
```

`ordinal` is the decimal integer as a string (`"1"`). The `fp1` version prefix lets a future `fp2`
coexist; never change `fp1` semantics — add a new version and keep matching on the old one.

## Known limitations

- Two identical reference-less rows split across two files at the statement boundary (one in each) get
  ordinal 1 in both and are flagged duplicate; the preview shows every duplicate so the user can override.
- A bank that rewrites descriptions between exports and has no references will not dedup automatically;
  the reconciliation step (amount + date ± tolerance) in `reconcile.ts` surfaces those as `matched` candidates.
