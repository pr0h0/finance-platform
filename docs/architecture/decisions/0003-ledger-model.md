# 0003 — Ledger model

Status: accepted (Phase 0)

## Decision
A **transaction** is the editable user interpretation (kind, dates, description, merchant, notes, tags,
reporting exclusion, links). Its money movement is a set of **postings** — one row per affected owned
account, signed, in the account's settlement currency. Category allocation is a set of **splits**.

| kind | postings | splits |
|---|---|---|
| `expense` | 1 negative on the paying account | required (≥1, uncategorized allowed: `category_id NULL`) summing to \|posting\| |
| `income` | 1 positive | same |
| `refund` | 1 positive, `related_transaction_id` → original | categories of the refunded spend; reduce that category's spending |
| `transfer` | −X on source, +X on destination (same currency) | none; never income/expense |
| `fx` | −X source currency, +Y target currency; `currency_conversions` row records rate + fee | none (fee may be a separate expense) |
| `opening_balance` | 1 posting setting the starting balance | none; excluded from income/expense |
| `adjustment` | correction posting(s), `corrects_transaction_id` + `transaction_adjustments` row | optional |

- Balances = `SUM(postings.amount)` per account+currency where the posting and its transaction are not
  deleted/void. `financial_snapshots` are caches tagged with the `sync_version` they were computed at.
- Credit-card **payments** are `transfer`s (checking → credit_card liability account), so purchases on the
  card are counted once (as expenses on the card account).
- Savings transfers are `transfer`s; goal progress comes from `savings_contributions` or a dedicated account.
- Cross-currency card spend: posting `amount` in account currency, `original_amount/original_currency`
  keeps the foreign amount.
- **Postings are immutable** (DB trigger `postings_immutable`): changing the amount of a *manual*
  transaction soft-deletes the old postings and inserts new ones in the same DB transaction (audited);
  for *imported* transactions amount/date/account edits are refused — record an `adjustment`.
- **Imported evidence** (`imported_raw_records`) is never updated (trigger `imported_raw_records_immutable`);
  transactions reference it via `import_record_id`. Reprocessing creates new raw records in a new batch and
  re-links, preserving user interpretation (categories, notes) on the transaction rows.

## Consequences
Analytics: spending = splits of `expense` minus splits of `refund`, joined through non-excluded,
non-deleted transactions; transfers/fx/opening_balance never count. Full double-entry with income/expense
accounts was rejected as unnecessary complexity for a personal finance app.
