# Raiffeisen Bank BiH importer — BLOCKED_EXTERNAL

Status: **BLOCKED_EXTERNAL** (PLAN Feature 121). Only the plug-in slot exists.

The real Raiffeisen Bank d.d. Bosna i Hercegovina statement format has not been provided, so no
columns, encodings, date/number formats or identifiers are implemented. Nothing here may be guessed.

## What exists
- `index.ts`: a registered manifest with `status: 'blocked_external'` and `formats: []`.
  `detect()` always returns confidence 0 and `parse()` throws `importer_blocked`, so the UI can list
  the bank as "coming soon" without ever producing data.

## What is needed to implement it
1. One or more **sanitized** statement exports per format the bank offers (CSV / XLSX / PDF /
   MT940 / CAMT…), with personal data replaced but structure, encoding, headers, separators and
   footer rows untouched. Never commit real statements.
2. For each format, decide: is it a standard format (MT940/CAMT → reuse the generic importer, maybe
   with a small adapter) or tabular (→ a declarative template JSON in this directory)?
3. Add synthetic fixtures under `packages/test-fixtures/imports/raiffeisen-bih/` that mimic the
   sanitized structure, plus parser / error / duplicate / encoding / date / currency tests
   (see `docs/importing/contributing.md`).
4. Flip `status` to `beta`, list the formats, bump `version` to `1.0.0`.

The transaction model does not change: the importer only has to emit `NormalizedRecord`s.
