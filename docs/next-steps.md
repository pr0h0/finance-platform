# Next steps

Phase 1 (backend) in PLAN §52 milestone order, each module inside `apps/api/internal/<module>`:
1. auth/users/profiles/households — sessions, CSRF, registration policy, `auth.Middleware` principal,
   profile membership; seed default categories on profile creation.
2. accounts, ledger, transactions, categories, merchants — postings derivation, splits, refunds,
   transfers, adjustments, balances, search; PLAN §46 cases 1–7.
3. currency, exchangerates — ECB provider job, historical lookup, manual overrides, `/convert`.
4. planning, recurrence, budgets, savings — RRULE expansion with month-end clamping, matching.
5. analytics, forecasting — shared fixtures in `packages/test-fixtures` for TS/Go equivalence.
6. imports (+ `packages/importer-sdk`, `packages/bank-importers` generic CSV/TSV/XLSX/OFX/QIF/CAMT.053/MT940).
7. sync, attachments, backups, notifications, automation, audit, admin.
8. mcp — Streamable HTTP transport at `/mcp` using `packages/mcp-contracts` semantics.
Phase 2: web app (local mode on IndexedDB `LocalStore`, connected mode, PWA, Playwright journeys).
Deployment: dedicated cloudflared tunnel `fin.pr0h0.me → 127.0.0.1:3810`.
