# Implementation status

Tracks all 145 features of PLAN.md. Update the row in the same commit as the work.

Statuses: `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED` (code exists, not fully verified),
`TESTED` (automated tests pass + functionally verified), `BLOCKED_EXTERNAL`, `DEFERRED_TO_PHASE`.
DEFERRED_TO_PHASE is **not** complete. Phase numbers follow PLAN §3 (1 backend, 2 web, 3 mobile, 4 desktop).

Current target: backend + web (Phases 1–2). Mobile (3) and desktop (4) are deferred.

## Foundation (Phase 0)

| Item | Status | Tests |
|---|---|---|
| Monorepo, Bun workspaces, 15 packages | TESTED | `scripts/bun.sh test packages apps/web/src` |
| Go API skeleton, module layout, config, logging redaction, error format | TESTED | `scripts/go.sh test ./...` |
| PostgreSQL schema (all PLAN §6 entities), goose migrations | TESTED | migrations apply on startup; trigger tests in internal/changes |
| Sync change log + audit helper (`internal/changes`) | TESTED | internal/changes tests (DB) |
| Profile authorization helper (`internal/authz`) | TESTED | internal/authz tests (DB) |
| Idempotency-Key middleware | TESTED | internal/httpx tests (DB) |
| Money engine TS + Go, conformance fixtures | TESTED | both runners pass packages/test-fixtures/conformance |
| OpenAPI 3.1 contract | IMPLEMENTED | redocly lint: valid |
| Docker (dev + prod-like), gateway on 127.0.0.1:3810 | TESTED | health/meta via gateway, Chromium render check |
| CI workflow | IMPLEMENTED | not yet run on GitHub |

## Features

| # | Name | Platforms | Phase | Status | Backend module / package | Tests | Notes / limitations |
|---|---|---|---|---|---|---|---|
| 1 | Expense tracking | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 2 | Income tracking | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 3 | Multiple accounts | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 4 | Transfers between accounts | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 5 | Transaction categories | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 6 | Subcategories | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 7 | Custom tags | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 8 | Split transactions | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — | Phase 0: transaction_splits table + split invariant in engine/validation. |
| 9 | Transaction attachments | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 10 | Transaction search and filtering | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 11 | Quick expense entry | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 12 | Transaction templates | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 13 | Refunds and reimbursements | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 14 | Transaction import | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 15 | Transaction export | API, Web | 1-2 | NOT_STARTED | transactions, accounts, categories, attachments, imports | — |  |
| 16 | Multiple currencies | API, Web | 1-2 | NOT_STARTED | currency, exchangerates | — | Phase 0: schema, ISO 4217 scales, exact engine (TS+Go) with conformance fixtures. |
| 17 | Primary reporting currency | API, Web | 1-2 | NOT_STARTED | currency, exchangerates | — |  |
| 18 | Automatic conversion | API, Web | 1-2 | NOT_STARTED | currency, exchangerates | — | Phase 0: exact conversion functions (TS+Go), shared fixtures. |
| 19 | Historical rates | API, Web | 1-2 | NOT_STARTED | currency, exchangerates | — | Phase 0: exchange_rates snapshot table; EUR/BAM fixed rate seeded. |
| 20 | Manual override | API, Web | 1-2 | NOT_STARTED | currency, exchangerates | — |  |
| 21 | Multi-currency accounts | API, Web | 1-2 | NOT_STARTED | currency, exchangerates | — |  |
| 22 | Currency fees | API, Web | 1-2 | NOT_STARTED | currency, exchangerates | — |  |
| 23 | Built-in converter | API, Web | 1-2 | NOT_STARTED | currency, exchangerates | — |  |
| 24 | Currency analytics | API, Web | 1-2 | NOT_STARTED | currency, exchangerates | — |  |
| 25 | Exchange-rate updates | API, Web | 1-2 | NOT_STARTED | currency, exchangerates | — |  |
| 26 | Planned expenses | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 27 | Recurring expenses | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 28 | Recurring income | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 29 | Subscription manager | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 30 | Bill calendar | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 31 | Payment reminders | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 32 | Planned versus actual | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 33 | Planned transaction matching | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 34 | Flexible recurrence | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 35 | Expense priorities | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 36 | Confidence levels | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 37 | Installment payments | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 38 | Annual planning | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 39 | Category budgets | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 40 | Monthly budgets | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 41 | Custom budget periods | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 42 | Rollover | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 43 | Budget alerts | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 44 | Actual versus budget | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 45 | Planned spending consideration | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 46 | Budget templates | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 47 | Financial overview | Web (+API) | 2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 48 | Customizable widgets | Web (+API) | 2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 49 | Current balance | API, Web | 1-2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 50 | Upcoming expenses | API, Web | 1-2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 51 | Monthly summary | API, Web | 1-2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 52 | Account breakdown | API, Web | 1-2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 53 | Quick actions | Web (+API) | 2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 54 | Spending by category | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 55 | Income versus expenses | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 56 | Spending trends | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 57 | Period comparisons | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 58 | Merchant analytics | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 59 | Savings rate | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 60 | Recurring cost analysis | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 61 | Net worth | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 62 | Financial reports | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 63 | Report export | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 64 | Automated financial insights | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 65 | Unusual expense detection | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 66 | Future balance forecasting | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 67 | Daily cash flow | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 68 | Safe-to-spend | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 69 | What-if scenarios | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 70 | Optimistic and conservative forecasts | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 71 | Long-term projections | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 72 | Savings goals | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 73 | Goal contributions | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 74 | Goal completion estimates | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 75 | Emergency fund tracking | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 76 | Categorization rules | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 77 | Transaction suggestions | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 78 | Duplicate detection | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 79 | Receipt scanning | API, Web | 1-2 | NOT_STARTED | automation, transactions | — | Web: upload/camera capture + user-verified breakdown. Native camera flows Phase 3. |
| 80 | Recurring payment detection | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 81 | Smart notifications | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 82 | Global shortcuts | API, Web | 1-2 | NOT_STARTED | automation, transactions | — | Web: in-app keyboard shortcuts. OS-global shortcuts are desktop (Phase 4). |
| 83 | Bulk editing | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 84 | Undo and history | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 85 | Local-first storage | API, Web | 1-2 | NOT_STARTED | web storage, sync, backups, auth, households | — | Phase 0: storage abstraction interface (packages/storage). |
| 86 | Offline mode | API, Web | 1-2 | NOT_STARTED | web storage, sync, backups, auth, households | — |  |
| 87 | Optional cloud synchronization | API, Web | 1-2 | NOT_STARTED | web storage, sync, backups, auth, households | — |  |
| 88 | End-to-end encryption | API, Web | 1-2 | NOT_STARTED | web storage, sync, backups, auth, households | — | Phase 0: design in ADR 0005; key_envelopes table. |
| 89 | Automatic backups | API, Web | 1-2 | NOT_STARTED | web storage, sync, backups, auth, households | — |  |
| 90 | Backup restoration | API, Web | 1-2 | NOT_STARTED | web storage, sync, backups, auth, households | — |  |
| 91 | Application lock | API, Web | 1-2 | NOT_STARTED | web storage, sync, backups, auth, households | — | Web: PIN/passphrase lock. Biometric lock is mobile/desktop (Phase 3/4). |
| 92 | Financial profiles | API, Web | 1-2 | NOT_STARTED | web storage, sync, backups, auth, households | — |  |
| 93 | Household sharing | API, Web | 1-2 | NOT_STARTED | web storage, sync, backups, auth, households | — |  |
| 94 | Data portability | API, Web | 1-2 | NOT_STARTED | web storage, sync, backups, auth, households | — |  |
| 95 | macOS | macOS desktop (Tauri) | 4 | DEFERRED_TO_PHASE | platform | — | Desktop is developed later on macOS hardware. |
| 96 | Windows | Windows desktop (Tauri) | 4 | DEFERRED_TO_PHASE | platform | — | Desktop is developed later on Windows hardware. |
| 97 | Linux | Linux desktop (Tauri) | 4 | DEFERRED_TO_PHASE | platform | — | Desktop deferred; architecture (storage abstraction, mcp-contracts) kept compatible. |
| 98 | Web | API, Web | 1-2 | NOT_STARTED | platform | — | Phase 0 shell only (server status page). |
| 99 | Mobile | Android, iOS | 3 | DEFERRED_TO_PHASE | platform | — | Mobile is Phase 3. |
| 100 | Cross-platform synchronization | API, Web | 1-2 | NOT_STARTED | platform | — | Web<->server sync in Phase 1-2; mobile/desktop clients later. |
| 101 | Bank statement import | API, Web | 1-2 | NOT_STARTED | platform | — |  |
| 102 | Optional bank integrations | API, Web | 1-2 | NOT_STARTED | platform | — |  |
| 103 | Themes | Web | 2 | NOT_STARTED | platform | — |  |
| 104 | Localization | API, Web | 1-2 | NOT_STARTED | platform | — | Phase 0: packages/localization skeleton (en catalog, fallback). |
| 105 | Accessibility | Web | 2 | NOT_STARTED | platform | — |  |
| 106 | First-launch mode selection | Web (+API) | 2 | NOT_STARTED | web, sync, api-client | — |  |
| 107 | Custom backend URL | API, Web | 1-2 | NOT_STARTED | web, sync, api-client | — |  |
| 108 | Synchronization dashboard | Web (+API) | 2 | NOT_STARTED | web, sync, api-client | — |  |
| 109 | Server migration | API, Web | 1-2 | NOT_STARTED | web, sync, api-client | — |  |
| 110 | Bank importer registry | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 111 | Custom bank templates | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 112 | Code-based bank adapters | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 113 | Import preview | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 114 | Import history and rollback | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 115 | Import deduplication | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 116 | Account reconciliation | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 117 | Mapping editor | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 118 | Community templates | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 119 | Device management | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 120 | Self-hosted administration | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 121 | Raiffeisen Bank BiH integration | API, Web | 1 | BLOCKED_EXTERNAL | imports, importer-sdk, bank-importers | — | Needs a real (sanitized) Raiffeisen BiH statement. Only the plug-in slot exists (packages/bank-importers blockedImporters). |
| 122 | Historical import | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 123 | Editable imported records | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 124 | Unlimited category splitting | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — | Phase 0: split invariant + allocation (largest remainder) in engine. |
| 125 | Merchant-specific templates | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 126 | Uncategorized inbox | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 127 | Historical completeness | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 128 | Immutable source preservation | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — | Phase 0: imported_raw_records with DB immutability trigger. |
| 129 | Opening balance reconstruction | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 130 | Import reprocessing | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 131 | Local MCP server | Desktop | 4 | DEFERRED_TO_PHASE | mcp, mcp-contracts | — | Native local MCP server ships with desktop; contracts in packages/mcp-contracts. |
| 132 | Remote MCP endpoint | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 133 | Per-client authorization | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 134 | Read-only queries | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 135 | Granular write access | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 136 | Categorization tools | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 137 | Split tools | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 138 | Budget and planning tools | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 139 | Cash-flow simulation | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 140 | AI financial analysis | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 141 | Proposed changes and approvals | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 142 | Audit history | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 143 | Client management | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 144 | Data scope restrictions | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 145 | MCP documentation | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — | Phase 0: packages/mcp-contracts tool schemas. |
