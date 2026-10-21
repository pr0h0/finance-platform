# MASTER IMPLEMENTATION PROMPT
# Open-Source Personal Finance & Expense Management Platform

## 0. Your role and primary objective

You are an autonomous senior software architect, financial software engineer, full-stack developer, security engineer, UI/UX designer, database architect, QA engineer, and DevOps engineer.

Your assignment is to design, implement, test, document, and deliver a complete, production-quality, open-source personal finance management platform.

This is NOT a prototype, proof of concept, or throwaway MVP.

The application must become a fully featured personal finance system with:

- Expense and income tracking.
- Multiple financial accounts.
- Comprehensive multi-currency support.
- Planned and recurring expenses.
- Budgets and spending limits.
- Advanced financial analytics.
- Historical expense comparisons.
- Future cash-flow forecasting.
- Savings goals.
- Transaction categorization and splitting.
- Bank statement importing.
- Extensible community bank importers.
- Local-first operation.
- Optional self-hosted synchronization.
- Web, mobile, and desktop applications.
- AI agent access through Model Context Protocol (MCP).
- Read-only AI analysis by default.
- Granular and controlled AI write operations.
- Encryption, privacy, backup, and recovery.
- Automated functional, integration, security, and end-to-end tests.

There are **145 planned features**, all of which belong to the final product scope.

Implement all applicable features in the correct phase. Do not silently omit features, replace them with mock implementations, or claim they work when they have not been tested.

The initial development target is a complete backend and web application.

Mobile and desktop applications are subsequent implementation phases, but the architecture must support them from the beginning.

### Fundamental instructions

1. Act autonomously and make reasonable technical decisions.
2. Do not repeatedly ask small implementation questions.
3. Document significant assumptions and decisions.
4. Prefer maintainability, security, and correctness over unnecessary complexity.
5. Do not sacrifice financial accuracy for implementation convenience.
6. Use reliable, actively maintained open-source dependencies.
7. Do not install unnecessary development tools globally on the host.
8. Use Docker for infrastructure and isolated development services.
9. Use Bun for JavaScript package management, not npm, pnpm, or Yarn.
10. Follow the explicitly defined development order.
11. Build real implementations, not decorative interfaces.
12. Verify functionality with automated tests and actual browser interaction.
13. If a feature is blocked by missing external information, document the dependency and implement everything else around it.
14. Do not claim incomplete or untested functionality is finished.
15. Maintain a feature checklist and implementation progress throughout development.

---

# PART I — PRODUCT PHILOSOPHY

## 1. Product concept

Build an application that helps users understand:

1. Where their money came from.
2. Where their money went.
3. How much money they currently have.
4. How much money they have committed to future expenses.
5. How much they can safely spend.
6. How their spending changes over time.
7. Which expenses are unnecessary or unusually high.
8. How much they can save.
9. What their finances might look like in the future.
10. How different financial decisions affect their situation.

This is a personal financial management tool, not a trading platform, banking application, or investment brokerage.

The application must be useful to an ordinary person who wants to record daily spending without learning complicated accounting concepts.

Advanced capabilities should be available without cluttering basic workflows.

## 2. Core product principles

### 2.1 Local-first

Users must be able to use the application without creating an account or connecting to a backend.

Local mode must support all functionality that does not inherently require a remote service.

Financial data belongs to the user.

### 2.2 Optional synchronization

Users may optionally connect to a compatible backend.

All synchronized devices use one central server.

Users may self-host this backend.

Cloud synchronization must not become mandatory for ordinary personal financial tracking.

### 2.3 No vendor lock-in

Users can export complete financial records and restore them elsewhere.

The application uses documented data formats and migration procedures.

### 2.4 Financial correctness

Financial amounts must be represented using exact arithmetic.

Never use JavaScript floating-point numbers for financial accounting calculations.

Transactions, transfers, foreign-exchange conversions, splits, refunds, and account balances must remain consistent.

### 2.5 Privacy

No mandatory telemetry.

No advertising.

No selling financial data.

External AI processing and connected services must always be optional.

### 2.6 Open source

The entire project must be designed for public contribution.

Bank importers, translations, integrations, UI enhancements, and other components should be extendable.

Provide contribution guidelines, tests, development documentation, and a clear licensing policy.

Prefer an established OSI-approved license. Document the trade-offs before selecting the final license.

### 2.7 Cross-platform consistency

The underlying finance engine must produce equivalent results on every platform.

Do not maintain independent financial calculation implementations that can drift.

Use shared domain contracts, portable business logic, and cross-platform conformance tests.

---

# PART II — REQUIRED IMPLEMENTATION ORDER

## 3. Development phases

Follow this order strictly.

### Phase 0 — Foundation and architecture

Before implementing business functionality:

1. Initialize the monorepo.
2. Configure Bun workspaces.
3. Establish shared TypeScript packages.
4. Establish Go backend structure.
5. Configure Docker Compose.
6. Configure PostgreSQL.
7. Create database migration tooling.
8. Establish testing frameworks.
9. Establish code quality rules.
10. Configure CI.
11. Define domain models and API contracts.
12. Define the synchronization protocol.
13. Define financial invariants.
14. Define platform persistence abstractions.
15. Create the feature implementation checklist.
16. Document architecture decisions.

Do not spend excessive time creating infrastructure that provides no immediate value.

### Phase 1 — Backend

Implement the production backend before building the full frontend.

The backend includes:

- Financial accounts.
- Transactions.
- Categories.
- Transaction splits.
- Currency management.
- Exchange rates.
- Planned transactions.
- Recurring schedules.
- Budgets.
- Savings goals.
- Financial calculations.
- Analytics.
- Forecasting.
- Authentication.
- Permissions.
- Synchronization.
- Bank importer framework.
- Import history.
- Attachments.
- Backups.
- User management.
- Household sharing.
- MCP remote endpoint.
- Audit logs.
- Administrative functionality.

Create comprehensive API, service, and database tests.

### Phase 2 — Web application

Build the complete responsive web interface.

The web application must support:

- Browser-local mode without a backend account.
- Connected mode using the Go backend.
- Offline transactions.
- Local persistence.
- Synchronization.
- Complete financial management.
- Importing and editing transactions.
- All relevant analytics and planning screens.
- Budgets and savings goals.
- Multi-currency functionality.
- Administrative interfaces.
- MCP connection management.
- Responsive mobile layouts.
- PWA installation.

Test everything using an actual browser.

### Phase 3 — Mobile applications

After backend and web functionality is working:

Implement Android and iOS applications.

Reuse the shared business logic, validation schemas, financial engine, and as much of the React UI as practical.

Adapt interactions appropriately for mobile.

Mobile priorities include:

- Quick expense entry.
- Offline financial records.
- Camera-based receipt capture.
- Native notifications.
- Biometric app locking.
- Background synchronization where supported.
- Mobile-friendly analytics.
- Full access to financial features.

### Phase 4 — Desktop applications

After mobile implementation:

Build desktop applications for:

- macOS.
- Windows.
- Linux.

Use Tauri 2 with Rust and the shared React frontend.

Desktop-specific functionality includes:

- Local SQLite persistence.
- Native file importing.
- System tray.
- Global shortcuts.
- Native notifications.
- Automatic updates.
- Secure local storage.
- Desktop backups.
- Local MCP server.
- Integration with local AI agents.
- Native file associations where beneficial.

### Phase 5 — Final integration and hardening

Complete:

- Cross-platform regression testing.
- Security reviews.
- Performance optimization.
- Synchronization stress testing.
- Historical data migration tests.
- Importer compatibility testing.
- Backup and recovery testing.
- Accessibility audits.
- Release packaging.
- Deployment documentation.
- Contribution documentation.
- Production readiness verification.

Do not treat the project as completed until the feature checklist and required tests are satisfied.

---

# PART III — TECHNICAL ARCHITECTURE

## 4. Technology stack

Use the following baseline stack.

### Backend

- Go.
- PostgreSQL.
- REST API with OpenAPI 3.1 documentation.
- WebSocket or Server-Sent Events where real-time communication is necessary.
- Secure cookie or token-based authentication appropriate to client type.
- Versioned synchronization protocol.
- Background job processing.
- Structured logging.
- Database migrations.
- Docker deployment.

Prefer a clean Go HTTP stack with established routing and validation libraries.

Avoid unnecessary enterprise architecture patterns.

### Frontend

- React.
- TypeScript in strict mode.
- Vite.
- Tailwind CSS.
- TanStack Query for remote state management.
- Zustand where useful for local UI state.
- React Router or TanStack Router.
- Recharts for financial graphs.
- Accessible component primitives.
- Bun for dependencies and scripts.

Avoid Next.js unless a specific indispensable technical requirement is discovered.

### Local persistence

Web:

- IndexedDB.
- Versioned storage schema.
- Transactional local operations.
- An abstraction capable of supporting future storage changes.

Desktop and mobile:

- SQLite.
- Schema migrations.
- Transactional persistence.
- Platform-specific secure key storage.

### Cross-platform applications

- Tauri 2.
- Rust for native integration.
- Shared React application.
- Platform-specific adapters.
- Native plugins where required.

Evaluate Tauri mobile plugin availability before depending on specific capabilities.

If a platform requirement cannot be met reliably with Tauri, document the limitation and evaluate a suitable platform-specific implementation rather than silently dropping functionality.

### Infrastructure

- Docker Compose.
- PostgreSQL container.
- Go API container.
- Web application container.
- Reverse proxy.
- Optional background worker.
- Optional S3-compatible object storage.
- Optional observability services.

The baseline single-user deployment should remain simple.

Avoid mandatory Redis, Kafka, Kubernetes, or other infrastructure unless justified.

---

## 5. Suggested monorepo

Use a structure similar to:

```text
finance-platform/
├── apps/
│   ├── web/
│   ├── mobile/
│   ├── desktop/
│   └── api/
│
├── packages/
│   ├── domain/
│   ├── finance-engine/
│   ├── forecasting/
│   ├── currency/
│   ├── api-client/
│   ├── sync-client/
│   ├── storage/
│   ├── ui/
│   ├── charts/
│   ├── validation/
│   ├── bank-importers/
│   ├── importer-sdk/
│   ├── mcp-contracts/
│   ├── localization/
│   └── test-fixtures/
│
├── infrastructure/
│   ├── docker/
│   ├── migrations/
│   ├── deployments/
│   └── monitoring/
│
├── docs/
│   ├── architecture/
│   ├── api/
│   ├── development/
│   ├── deployment/
│   ├── importing/
│   ├── mcp/
│   ├── security/
│   └── contributing/
│
├── scripts/
├── tests/
├── AGENTS.md
├── CLAUDE.md
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── docker-compose.yml
└── package.json
```

Use Go modules for backend dependencies.

Use Bun workspaces for TypeScript packages.

Avoid duplicated financial calculations.

Generate TypeScript API types and validation contracts from a documented source of truth wherever practical.

---

# PART IV — FINANCIAL DATA MODEL

## 6. Core entities

Design relational entities for:

- Users.
- Financial profiles.
- Households.
- Household membership.
- Accounts.
- Account types.
- Transactions.
- Transaction entries or postings.
- Transaction splits.
- Transaction adjustments.
- Categories.
- Category hierarchies.
- Tags.
- Transaction-tag associations.
- Merchants.
- Budgets.
- Budget allocations.
- Budget periods.
- Budget rollover policies.
- Planned transactions.
- Recurrence schedules.
- Subscriptions.
- Savings goals.
- Savings contributions.
- Currency definitions.
- Exchange-rate snapshots.
- Exchange-rate providers.
- Currency conversion records.
- Attachments.
- Bank statements.
- Import batches.
- Imported raw records.
- Import templates.
- Import reconciliation results.
- Categorization rules.
- Financial snapshots.
- Sync changes.
- Sync checkpoints.
- Devices.
- Sessions.
- MCP clients.
- MCP permission grants.
- MCP proposed changes.
- Audit log entries.
- Notifications.
- Application settings.
- Encrypted backup metadata.

Every entity must have stable identifiers.

Support local creation before server synchronization.

Use UUID or another well-defined collision-resistant identifier strategy.

Store timestamps in UTC where they represent instants.

Preserve user timezones and local calendar dates where they affect financial periods, statement dates, or recurrence schedules.

A date-only bank posting date must not shift to a different day because the user changes timezone.

Do not use server receipt time as a substitute for transaction date.

## 7. Accounting model

Prefer a ledger-oriented financial model.

Each monetary movement must be represented consistently.

Support:

- Income.
- Expenses.
- Transfers.
- Refunds.
- Reimbursements.
- Foreign-exchange conversions.
- Account opening balances.
- Reconciliation adjustments.
- Liability and debt payments.
- Savings contributions.
- Split expenses.

Transfers between owned accounts must not be counted as spending.

Internal savings transfers must not automatically count as income or expenses.

Credit-card payments must not cause purchases to be counted twice.

Keep source currency amounts and settlement currency amounts separately where appropriate.

Model postings so account balances can be reconstructed from the ledger.

Store any derived balances as caches, never as independent authoritative state.

Use immutable posting history or a similarly auditable correction model for financial movements.

## 8. Monetary representation

Never store monetary amounts as binary floating-point values.

Use one of:

- Integer minor units where the currency's scale permits.
- Exact decimal numeric types.
- Validated decimal strings in serialized API payloads.

Handle currencies with different decimal scales correctly.

Store exchange rates at sufficient decimal precision.

Round monetary amounts only at defined accounting boundaries.

Do not repeatedly round intermediate calculations.

Implement explicit and tested rounding policies.

Example:

```ts
type Money = {
  amountMinor: string;
  currency: string;
};
```

A decimal-string representation may be more appropriate for some operations.

Pick one authoritative representation and use it consistently.

## 9. Transaction preservation

An imported bank transaction contains two conceptual layers.

### Immutable source record

Preserve:

- Original bank description.
- Original posting date.
- Original value date, if present.
- Original debit or credit amount.
- Original currency.
- Bank reference.
- Statement reference.
- Statement identifier.
- Source account.
- Raw source data.
- Source file fingerprint.
- Importer identifier and version.

### Editable user interpretation

Allow editing:

- Display description.
- Merchant.
- Categories.
- Category splits.
- Tags.
- Notes.
- Attachments.
- Transaction classification.
- Reporting exclusions.
- Planning relationships.

Changing a category must never alter the original bank amount.

If users need to correct account postings or amounts, implement explicit reconciled corrections or adjustments rather than rewriting imported evidence silently.

---

# PART V — ALL 145 FEATURES

## 10. Transactions and expenses — Features 1–15

### 1. Expense tracking

Users can record expenses with an amount, currency, date, category, description, account, and optional merchant.

Support creation, editing, duplication, archiving, and audited correction.

### 2. Income tracking

Support salaries, freelance income, bonuses, refunds, gifts, and custom income sources.

Differentiate genuine income from transfers and refunds.

### 3. Multiple accounts

Support bank accounts, cash wallets, savings accounts, credit cards, payment accounts, and custom accounts.

Each account has a currency and its own balance history.

### 4. Transfers between accounts

Implement transfers as connected financial movements.

Support multicurrency transfers with exchange rates and fees.

### 5. Transaction categories

Provide customizable income and expense categories with icons and colors.

### 6. Subcategories

Support hierarchical categories.

Allow grouping at parent-category or subcategory level.

### 7. Custom tags

Allow unlimited tags independent of categories.

Examples: Vacation, Work, Family, Reimbursable.

### 8. Split transactions

Split transactions across categories while keeping the original transaction total unchanged.

Allow unlimited splits within reasonable performance limits.

### 9. Transaction attachments

Attach receipts, invoices, images, and supporting documents.

Support secure local storage and optional synchronization.

### 10. Transaction search and filtering

Filter by amount, merchant, account, date, currency, category, tag, import source, and text.

### 11. Quick expense entry

Create transactions using a minimal form.

Remember recent selections when helpful.

### 12. Transaction templates

Save frequently repeated transaction structures.

Support one-click reuse.

### 13. Refunds and reimbursements

Link refunds to their original purchases.

Support partial refunds and reimbursements.

### 14. Transaction import

Import supported financial formats through the shared importer framework.

### 15. Transaction export

Export transactions and associated classifications to CSV, JSON, and spreadsheet-compatible formats.

---

## 11. Multi-currency — Features 16–25

### 16. Multiple currencies

Support BAM, EUR, USD, and other standard ISO currency codes.

### 17. Primary reporting currency

Allow users to choose their preferred reporting currency.

Changing it must not rewrite original transactions.

### 18. Automatic conversion

Convert transaction amounts into the reporting currency for analytics.

### 19. Historical rates

Preserve historical exchange rates.

Historical spending reports should use a documented valuation policy.

### 20. Manual override

Allow users to enter the actual settlement rate or amount charged by their bank.

### 21. Multi-currency accounts

Support accounts denominated in different currencies.

### 22. Currency fees

Track conversion commissions and bank markups separately.

### 23. Built-in converter

Provide a fast standalone converter.

Enable conversion results to become planned expenses.

### 24. Currency analytics

Analyze original-currency spending, conversion fees, and exposure.

### 25. Exchange-rate updates

Retrieve current and historical rates from configurable providers.

Cache results.

Support offline operation.

BAM/EUR uses the officially fixed parity of:

**1 EUR = 1.95583 BAM**

Use a configurable rate provider for currencies such as USD.

Store rate source and effective date.

Distinguish reference rates from actual bank settlement amounts.

---

## 12. Planning and recurring payments — Features 26–38

### 26. Planned expenses

Create future purchases with estimated amounts and dates.

### 27. Recurring expenses

Support rent, utilities, subscriptions, insurance, and other recurring costs.

### 28. Recurring income

Support salaries and other predictable income.

### 29. Subscription manager

Track subscription price, currency, renewal frequency, next payment, annualized cost, and cancellation status.

### 30. Bill calendar

Show future transactions on a calendar.

### 31. Payment reminders

Notify users before scheduled expenses.

### 32. Planned versus actual

Compare estimated transaction amounts with actual recorded payments.

### 33. Planned transaction matching

Match completed transactions with planned payments.

Avoid counting the same expense twice.

### 34. Flexible recurrence

Support daily, weekly, monthly, yearly, custom intervals, and appropriate calendar-based recurrence rules.

Define behavior for missing calendar days, weekends, timezones, and daylight-saving changes.

### 35. Expense priorities

Mark planned expenses as essential, optional, or deferrable.

### 36. Confidence levels

Mark plans as confirmed, estimated, or uncertain.

### 37. Installment payments

Track installment schedules, paid amounts, outstanding balances, and due dates.

### 38. Annual planning

Allow annual expenses to be anticipated and optionally allocated across monthly budgets.

---

## 13. Budgets — Features 39–46

### 39. Category budgets

Define category-specific spending limits.

### 40. Monthly budgets

Define overall monthly spending limits.

### 41. Custom budget periods

Support weekly, monthly, annual, and custom periods.

### 42. Rollover

Optionally carry unused budget amounts forward.

### 43. Budget alerts

Notify when thresholds are approached or exceeded.

### 44. Actual versus budget

Compare completed spending against allocated amounts.

### 45. Planned spending consideration

Show actual, committed, and remaining budget amounts separately.

### 46. Budget templates

Create reusable budgeting plans.

Allow different templates for different financial situations.

Do not require users to allocate every unit of income.

---

## 14. Dashboard — Features 47–53

### 47. Financial overview

Display important financial information immediately.

### 48. Customizable widgets

Allow rearrangement, visibility control, and saved layouts.

### 49. Current balance

Show balances for selected accounts and groups.

### 50. Upcoming expenses

Display scheduled expenses with due dates.

### 51. Monthly summary

Display income, expenses, net cash flow, and savings metrics.

### 52. Account breakdown

Show individual account balances and their share of available funds.

### 53. Quick actions

Provide immediate access to expense, income, transfer, and planned transaction creation.

Build dashboards using real domain data, not hardcoded numbers.

---

## 15. Analytics — Features 54–65

### 54. Spending by category

Use charts and tables to display category spending.

### 55. Income versus expenses

Compare monthly, quarterly, and annual income and spending.

### 56. Spending trends

Identify long-term changes.

### 57. Period comparisons

Compare custom periods and matching historical periods.

### 58. Merchant analytics

Group spending by merchant.

Support merchant normalization and aliases.

### 59. Savings rate

Calculate savings using a documented definition.

### 60. Recurring cost analysis

Show recurring spending as monthly and annual equivalents.

### 61. Net worth

Track assets and liabilities separately from ordinary spending.

### 62. Financial reports

Generate monthly, quarterly, annual, and custom-date reports.

### 63. Report export

Support PDF, CSV, and image export where suitable.

### 64. Automated financial insights

Identify meaningful spending patterns through deterministic analytics.

Do not require AI for ordinary insights.

### 65. Unusual expense detection

Flag large or anomalous spending using transparent rules.

Provide explanations and allow dismissal.

Every analytics view must handle incomplete historical data and multicurrency conversion correctly.

---

## 16. Forecasting and goals — Features 66–75

### 66. Future balance forecasting

Estimate balances based on future income and expenses.

### 67. Daily cash flow

Project account balances for individual dates.

### 68. Safe-to-spend

Estimate discretionary funds after commitments and minimum reserves.

### 69. What-if scenarios

Simulate purchases, income changes, and other financial events.

Never mutate real records during simulation.

### 70. Optimistic and conservative forecasts

Use different assumptions about uncertain transactions.

### 71. Long-term projections

Support arbitrary reasonable forecasting periods.

### 72. Savings goals

Create financial targets.

### 73. Goal contributions

Track contributions and progress.

### 74. Goal completion estimates

Estimate completion dates based on planned contributions.

### 75. Emergency fund tracking

Estimate how long reserves could cover essential expenses.

Forecasts must distinguish verified future obligations from estimates.

Do not present uncertain forecasts as guaranteed outcomes.

---

## 17. Automation — Features 76–84

### 76. Categorization rules

Allow rule-based categorization using merchant, description, account, and other conditions.

### 77. Transaction suggestions

Suggest categories based on user history.

### 78. Duplicate detection

Detect possible duplicate imports and manual entries.

### 79. Receipt scanning

Support OCR-based extraction through optional local processing.

The user must approve inferred financial values.

### 80. Recurring payment detection

Identify patterns suggesting subscriptions or recurring charges.

### 81. Smart notifications

Notify about bills, budgets, and meaningful financial changes.

### 82. Global shortcuts

Implement desktop shortcuts for common actions.

### 83. Bulk editing

Allow multiple transactions to be updated safely.

### 84. Undo and history

Provide auditable change history and reversible operations where applicable.

---

## 18. Privacy and data management — Features 85–94

### 85. Local-first storage

All financial workflows must function using local persistence where technically possible.

### 86. Offline mode

Allow offline transaction entry, editing, budgeting, and analytics.

### 87. Optional cloud synchronization

Connect to a compatible backend.

### 88. End-to-end encryption

Design and implement a defined end-to-end encrypted synchronization mode with documented key management and recovery limitations.

### 89. Automatic backups

Support scheduled local backups and optional server backups.

### 90. Backup restoration

Provide complete restore capabilities.

### 91. Application lock

Support password/PIN and platform biometrics where available.

### 92. Financial profiles

Support multiple independent profiles.

### 93. Household sharing

Allow authorized users to share financial profiles and budgets.

### 94. Data portability

Document exports and migration procedures.

---

## 19. Platforms and integrations — Features 95–105

### 95. macOS

Deliver a packaged macOS application.

### 96. Windows

Deliver a packaged Windows application.

### 97. Linux

Deliver compatible Linux packages.

### 98. Web

Deliver a responsive browser application and PWA.

### 99. Mobile

Deliver Android and iOS applications.

### 100. Cross-platform synchronization

Keep authorized data consistent across devices.

### 101. Bank statement import

Support local bank statement imports.

### 102. Optional bank integrations

Create extension points for authorized automated banking connections.

Do not assume a particular bank provides a usable public API.

### 103. Themes

Support light, dark, and system-based themes.

### 104. Localization

Support multiple languages, regional currency display, dates, and number formats.

Provide English as the initial language and structure translations to allow Bosnian and other languages.

### 105. Accessibility

Implement semantic markup, keyboard navigation, screen-reader compatibility, scalable interfaces, and appropriate contrast.

---

# PART VI — OPERATING MODES AND SYNCHRONIZATION

## 20. Local and connected modes — Features 106–109

### 106. First-launch mode selection

Show users two primary options:

**Local only**

- No registration.
- No backend required.
- All financial records stored locally.
- Offline operation.
- Optional encrypted backups.
- No automatic remote uploads.

**Connect to server**

- Enter a backend URL.
- Authenticate.
- Configure synchronization.
- Download available financial profiles.
- Use the application offline with local caching.
- Synchronize when connectivity returns.

Users must be able to change modes later.

### 107. Custom backend URL

Allow connections to any compatible self-hosted server.

Validate server identity and API compatibility.

Prevent accidental transmission to untrusted destinations.

### 108. Synchronization dashboard

Display:

- Connection status.
- Last successful synchronization.
- Pending changes.
- Synchronization errors.
- Conflicts.
- Connected devices.
- Storage usage where available.

### 109. Server migration

Allow moving between servers through a documented migration flow.

Do not delete data automatically when disconnecting.

---

## 21. Synchronization architecture

Use a deterministic, versioned synchronization protocol.

Requirements:

- Offline writes.
- Unique operation identifiers.
- Idempotent retries.
- Incremental push and pull.
- Durable checkpoints.
- Transactional application of changes.
- Server-side authorization.
- Logical deletion with tombstones.
- Device identity.
- Conflict detection.
- Schema compatibility checks.
- Interrupted synchronization recovery.
- Large historical data support.
- Attachment synchronization.
- Migration handling.

Do not implement financial synchronization as naïve last-write-wins database replication.

### Financial conflicts

Prefer immutable financial operations.

When conflicting updates occur:

- Preserve original data.
- Determine whether changes are non-overlapping.
- Merge safe metadata updates.
- Identify incompatible modifications.
- Require explicit resolution where necessary.
- Maintain an audit trail.

A synchronized split update must preserve its total.

### Sync activation

When converting an existing local profile to connected mode:

1. Establish an authenticated session.
2. Choose the destination profile.
3. Identify possible duplicates.
4. Preview upload and merge operations.
5. Upload data in recoverable batches.
6. Verify consistency.
7. Mark synchronization active only after successful initialization.

### Sync disabling

When disconnecting:

1. Ensure an appropriate complete local copy exists.
2. Inform the user about pending unsynchronized changes.
3. Disable remote operations.
4. Retain local records.
5. Offer remote deletion separately.

Never confuse account logout with data deletion.

---

## 22. End-to-end encryption design

Treat encryption as a first-class architecture decision, not a checkbox added at the end.

Define:

- Key generation.
- Key derivation.
- Encryption algorithms.
- Key storage.
- Device enrollment.
- Recovery codes.
- Encrypted backup format.
- Key rotation.
- Device revocation.
- Shared household access.
- Metadata exposure.
- Search and analytics limitations.

Use established cryptographic libraries.

Never create custom encryption algorithms.

### Crucial architectural constraint

A backend storing end-to-end encrypted financial data cannot freely perform server-side analytics on plaintext records.

Therefore, distinguish between:

**Private encrypted synchronization**

The server stores encrypted records.

Financial calculations and sensitive AI analysis occur on authorized clients after decryption.

**Explicit server-readable processing**

Users may optionally enable a mode with different privacy guarantees that permits server-side processing of accessible financial records.

Clearly explain this trade-off.

Do not misrepresent server-readable processing as end-to-end encrypted.

Implement key lifecycle and recovery tests before declaring encryption production-ready.

---

# PART VII — BANK IMPORT SYSTEM

## 23. Bank imports — Features 110–130

Create a reusable import framework supporting:

- Generic CSV.
- TSV.
- XLSX.
- XLS where feasible.
- Text-based PDF.
- Scanned PDF with optional OCR.
- OFX.
- QFX.
- QIF.
- CAMT.053.
- CAMT.054.
- MT940.
- JSON.

Specific bank parsers may support subsets of these formats.

Always validate what each importer actually supports.

### 110. Bank importer registry

Maintain a registry of supported importers.

### 111. Custom bank templates

Support declarative JSON templates.

### 112. Code-based bank adapters

Allow contributors to write custom parser modules.

### 113. Import preview

Display extracted records before saving.

### 114. Import history and rollback

Track batches and support safe rollback.

### 115. Import deduplication

Detect repeated transactions across overlapping statements.

### 116. Account reconciliation

Compare imported transactions with opening and closing balances.

### 117. Mapping editor

Create import mappings through the UI.

### 118. Community templates

Document contribution and testing procedures.

### 119. Device management

Manage devices authorized for synchronization.

### 120. Self-hosted administration

Provide appropriate server administration and diagnostics.

### 121. Raiffeisen Bank BiH integration

Raiffeisen Bank Bosnia and Herzegovina is the initial bank-specific target.

IMPORTANT:

The exact Raiffeisen parser will be implemented later when real statement format information is supplied.

Do not invent the statement's columns, file format, structure, or identifiers.

For now:

- Implement the importer SDK.
- Implement generic importers.
- Reserve a bank-specific integration directory.
- Create documented parser interfaces.
- Create synthetic fixtures.
- Create the importer selection UI.
- Ensure Raiffeisen-specific support can be plugged in later without changing the transaction model.

Mark bank-specific parsing as an explicit external-input dependency, not as a completed integration.

### 122. Historical import

Support importing years of statements in batches.

The intended initial historical range is December 2024 onward.

Do not enforce that date as a platform-wide restriction.

### 123. Editable imported records

Allow metadata modification without rewriting source records.

### 124. Unlimited category splitting

Allow arbitrary splits subject to validation and performance limits.

### 125. Merchant-specific templates

Save recurring merchant classifications and split patterns.

### 126. Uncategorized inbox

Provide a dedicated review interface.

### 127. Historical completeness

Track imported date coverage by account.

Distinguish:

- Complete.
- Partial.
- Missing.
- Unverified.
- Conflicting.

### 128. Immutable source preservation

Always retain sufficient original information for auditability.

### 129. Opening balance reconstruction

Use statement balances where available.

Otherwise allow manual opening balances and reconciliation adjustments.

### 130. Import reprocessing

Allow rerunning imports with improved parsers while preserving user classifications.

---

## 24. Importer plugin SDK

The importer SDK must define:

- Manifest schema.
- File detection.
- Supported formats.
- Parser interface.
- Normalized transaction output.
- Error and warning output.
- Confidence indicators.
- Reconciliation metadata.
- Importer versioning.
- Fixture-based testing.
- Security restrictions.

Example conceptual API:

```ts
interface BankImporter {
  id: string;
  version: string;

  detect(input: ImportInput): Promise<DetectionResult>;

  parse(
    input: ImportInput,
    context: ImportContext
  ): Promise<ImportResult>;
}
```

The normalized result should capture:

- Account reference.
- Statement reference.
- Posting date.
- Value date.
- Description.
- Debit/credit direction.
- Amount.
- Currency.
- Original transaction reference.
- Exchange information where present.
- Running balance where present.
- Raw record reference.
- Parsing warnings.

Include a JSON template system for simple delimited and spreadsheet exports.

For complex banks, permit code-based adapters.

### Plugin security

Do not automatically execute untrusted downloaded JavaScript with unrestricted permissions.

Built-in code adapters should be reviewed and bundled.

For custom executable adapters, establish a sandboxed execution approach with:

- No unrestricted filesystem access.
- No network access by default.
- Resource limits.
- Execution timeouts.
- Input size limits.
- Explicit permission grants.

Declarative templates should be the preferred end-user extension mechanism.

### Contribution requirements

Each contributed importer should include:

- Documentation.
- Schema version.
- Synthetic or sanitized fixtures.
- Parser tests.
- Error tests.
- Duplicate import tests.
- Encoding tests.
- Date parsing tests.
- Currency tests.

Never commit actual personal bank statements.

---

## 25. Import workflow

Implement:

1. Choose bank/importer.
2. Select one or more files.
3. Detect formats.
4. Parse into a staging area.
5. Show statement coverage.
6. Show extracted accounts.
7. Show income and expense totals.
8. Identify duplicates.
9. Identify parsing errors.
10. Suggest categories.
11. Allow selecting individual transactions.
12. Allow editing preliminary classifications.
13. Validate reconciliation.
14. Confirm import.
15. Persist original source and user-visible records.
16. Record the import batch.
17. Update analytics.
18. Offer review of uncategorized records.

Import must be recoverable after interruption.

Do not partially commit a logical transaction without preserving reconciliation integrity.

Use streaming or chunked processing for large files.

Do not force the entire archive into browser memory at once.

---

## 26. Split transaction behavior

Splitting is one of the most important workflows.

Example:

Original supermarket purchase:

150.00 BAM.

User allocation:

- Groceries: 95.40 BAM.
- Household items: 32.50 BAM.
- Leisure: 22.10 BAM.

Total: 150.00 BAM.

Rules:

1. The sum of splits must equal the original amount.
2. Negative or invalid allocations must be rejected unless explicitly supported by a documented adjustment workflow.
3. Original bank evidence must remain unchanged.
4. Editing split descriptions or categories must not affect account balances.
5. Split allocations participate correctly in category analytics.
6. The parent transaction must not also be counted as separate spending.
7. Users may add, remove, edit, and reorder splits.
8. Changes must be auditable.
9. Split templates must be reusable.
10. Bulk operations must preserve totals.
11. Sync conflicts must not create invalid splits.
12. Imported category metadata must survive parser updates.

A bank statement generally does not contain item-level grocery information.

Never fabricate product-level allocations.

If a receipt exists, allow a verified or user-approved breakdown.

---

# PART VIII — MCP AND AI AGENT ACCESS

## 27. MCP features — 131–145

Implement Model Context Protocol integration using current official protocol specifications and secure transport practices.

Two MCP modes are required.

### Local MCP

Desktop-specific.

- Works without a backend.
- Uses locally authorized application services.
- Prefer stdio transport.
- Disabled by default.
- Supports offline analysis.
- Uses scoped permissions.

### Remote MCP

Hosted by the Go backend.

- Authenticated.
- Uses supported Streamable HTTP transport.
- Provides granular permissions.
- Supports access revocation.
- Enforces profile and household authorization.
- Does not bypass encryption boundaries.

The backend MCP is implemented during the backend phase.

The local desktop MCP is implemented during the desktop phase.

Do not create two incompatible sets of tool semantics.

### 131. Local MCP server

Create a desktop-accessible MCP integration.

### 132. Remote MCP endpoint

Create a backend MCP endpoint.

### 133. Per-client authorization

Each client receives separate permissions.

### 134. Read-only queries

Provide financial read and aggregate operations.

### 135. Granular write access

Write permissions must be explicitly granted.

### 136. Categorization tools

Allow approved AI-assisted categorization.

### 137. Split tools

Allow approved transaction splitting.

### 138. Budget and planning tools

Allow authorized planning modifications.

### 139. Cash-flow simulation

Expose deterministic forecasting to AI clients.

### 140. AI financial analysis

Provide appropriate financial summaries and patterns.

### 141. Proposed changes and approvals

Allow agents to prepare changes for review.

### 142. Audit history

Record significant MCP activity.

### 143. Client management

Allow disconnection and revocation.

### 144. Data scope restrictions

Restrict access by account, profile, time period, resource, and capability.

### 145. MCP documentation

Provide integration examples and developer instructions.

---

## 28. MCP read-only tools

Implement at least:

```text
get_financial_overview
list_accounts
get_account_balance
list_transactions
get_transaction
get_spending_by_category
get_spending_by_merchant
compare_periods
get_income_summary
get_budget_status
list_recurring_expenses
list_planned_expenses
get_cash_flow_forecast
get_savings_goals
get_currency_exposure
get_import_coverage
get_uncategorized_transactions
simulate_expense
```

Financial tools should support:

- Date filters.
- Account filters.
- Profile filters.
- Currency selection.
- Pagination.
- Aggregate queries.
- Result size limits.
- Consistent errors.
- Explicit reporting of incomplete data.

Whenever possible, compute aggregates inside the financial engine instead of exporting thousands of raw transactions to an AI provider.

## 29. MCP write tools

Implement controlled support for:

```text
update_transaction_category
split_transaction
bulk_categorize_transactions
update_transaction_metadata
create_planned_expense
update_planned_expense
create_budget
update_budget
create_savings_goal
create_categorization_rule
preview_changes
apply_approved_changes
```

Each write operation must:

1. Validate the request.
2. Check permissions.
3. Check account/profile scope.
4. Check financial invariants.
5. Produce an auditable change.
6. Use idempotency where necessary.
7. Respect approval requirements.
8. Return clear success or failure details.

### Default permissions

MCP is disabled by default.

When enabled, default to read-only.

Allow separate grants for:

- Reading aggregate analytics.
- Reading individual transactions.
- Reading merchant information.
- Reading attachments.
- Editing categories.
- Editing splits.
- Editing tags and descriptions.
- Creating planned transactions.
- Editing budgets.
- Editing savings goals.

Avoid broad unrestricted database write permissions.

### Approval workflow

Support:

- Proposal-only operations.
- Per-change approval.
- Batch approval.
- Previously authorized low-risk operations where explicitly configured.

Approval must be enforced by the application or authorization service, not merely requested from the AI model.

### Data privacy

Make clear that data exposed to third-party AI agents may leave the user's device.

Do not silently send financial data to an AI provider.

---

# PART IX — USER INTERFACE

## 30. UX design requirements

Build a clean, modern, responsive financial application.

Visual principles:

- Clear information hierarchy.
- Minimal clutter.
- High information density where useful.
- Readable typography.
- Consistent spacing.
- Accessible contrast.
- Responsive layouts.
- Clear transaction statuses.
- Consistent currency formatting.
- Meaningful charts.
- Fast navigation.
- Predictable interactions.

Avoid unnecessary gradients, oversized hero panels, decorative animations, and dashboard cards without useful information.

Use Lucide or a consistent SVG icon library.

Icons should represent their meaning clearly.

Never use emojis as primary interface icons.

## 31. Navigation structure

Main application sections:

1. Dashboard.
2. Transactions.
3. Planning.
4. Budgets.
5. Analytics.
6. Accounts.
7. Savings Goals.
8. Subscriptions.
9. Import Center.
10. Automation Rules.
11. Reports.
12. Settings.

Contextual sections may include:

- Notifications.
- Household.
- MCP Connections.
- Devices.
- Sync Status.
- Administration.

Desktop and web may use a collapsible sidebar.

Mobile should use bottom navigation for common sections, with secondary navigation elsewhere.

---

## 32. Dashboard

Implement configurable widgets for:

- Total balance.
- Individual account balances.
- Current month income.
- Current month expenses.
- Net cash flow.
- Savings rate.
- Projected month-end balance.
- Upcoming bills.
- Budget utilization.
- Category distribution.
- Spending trends.
- Recent transactions.
- Largest expenses.
- Recurring subscriptions.
- Savings goal progress.
- Financial insights.
- Data import coverage.
- Sync health.

Allow users to customize layouts.

Store configuration per user/profile.

---

## 33. Transactions page

Provide:

- Fast transaction table.
- Date filters.
- Account filters.
- Category filters.
- Merchant filters.
- Currency filters.
- Tags.
- Search.
- Sorting.
- Pagination or virtualization.
- Bulk selection.
- Bulk editing.
- Transaction details.
- Original bank record inspection.
- Category split editor.
- Receipt viewer.
- Import source indicator.
- Planned transaction matching.
- Refund association.

Large historical transaction datasets must remain performant.

---

## 34. Planning page

Include:

- Calendar view.
- List view.
- Timeline view.
- Recurring obligations.
- Planned purchases.
- Planned income.
- Forecast balances.
- Commitment totals.
- What-if scenarios.

Allow easy editing of future transactions.

Support reminders and recurrence exceptions.

---

## 35. Analytics page

Provide interactive charts:

- Expense by category.
- Income versus expenses.
- Monthly spending.
- Historical spending trends.
- Merchant rankings.
- Subscription spending.
- Savings rate.
- Forecast evolution.
- Net worth.
- Currency distribution.
- Planned versus actual.

Charts must support filtering and useful tooltips.

Allow drilling down from aggregated figures to the underlying transactions.

---

## 36. First-launch experience

Implement an onboarding wizard.

Steps:

1. Welcome.
2. Language and region.
3. Primary currency.
4. Operating mode.
5. Local profile or server authentication.
6. Initial accounts.
7. Optional opening balances.
8. Default categories.
9. Optional data import.
10. Dashboard.

Allow skipping optional steps.

Do not force a sample dataset into real financial accounts.

Offer a clearly labeled demonstration mode if useful.

---

# PART X — PLATFORM-SPECIFIC REQUIREMENTS

## 37. Web application — Build first

The web application must be fully functional before starting native clients.

### Browser-local mode

Support:

- Local IndexedDB persistence.
- Offline operation.
- No required account.
- Full transaction management.
- Local analytics.
- Budgets.
- Forecasts.
- Importing statements.
- Exporting data.
- Local backup.

Clearly explain that browser data may be deleted by browser storage clearing or eviction.

Offer prominent backup functionality.

Handle storage quotas and unsupported browser capabilities gracefully.

Do not promise that browser-local storage is as durable as a desktop database.

### Connected web mode

Support:

- Authentication.
- Server connection.
- Incremental synchronization.
- Offline edits.
- Conflict handling.
- Device management.
- Remote profiles.
- Households.
- Encrypted sync when configured.

### PWA

Implement:

- Installable manifest.
- Offline application shell.
- Appropriate caching.
- Update behavior.
- Responsive mobile layouts.

Avoid caching sensitive API responses in inappropriate shared caches.

---

## 38. Mobile applications — Build second

Create Android and iOS clients after the web application.

Requirements:

- Local SQLite.
- Offline-first architecture.
- Secure credential storage.
- Biometric app lock.
- Fast expense entry.
- Receipt capture.
- Native file selection.
- Import preview.
- Push/local notifications as supported.
- Sync status.
- Native sharing integration.
- Mobile budget views.
- Mobile analytics.
- Savings goals.
- Account management.
- Multicurrency entry.
- Household features.

### Mobile interface

Prioritize thumb-friendly controls.

Use bottom navigation and floating quick-entry actions where appropriate.

Do not copy dense desktop transaction tables unchanged onto small screens.

Support accessibility text scaling.

### Background synchronization

Implement according to actual Android and iOS background execution constraints.

Do not assume unrestricted background execution.

Recover gracefully when synchronization is delayed.

### Mobile MCP

A directly hosted local MCP server is not required for the first mobile implementation.

Mobile clients must remain compatible with backend MCP-related permissions and financial data.

Do not introduce insecure background servers merely to offer MCP locally on a phone.

---

## 39. Desktop applications — Build third

Implement:

- macOS.
- Windows.
- Linux.

Use Tauri 2 and Rust.

### Desktop requirements

- SQLite persistence.
- Local file picker.
- Drag-and-drop statement importing.
- Native notifications.
- System tray.
- Global shortcuts.
- Automatic updates with signed releases.
- Secure app storage.
- Backup scheduling.
- Native account/profile switching.
- Optional startup launch.
- Local MCP bridge.
- Offline analytics.
- Robust large-file support.

### Local MCP

The local MCP server should communicate with a controlled local application service.

Do not expose raw unrestricted SQLite access to AI clients.

Do not expose an unauthenticated local network endpoint.

Use appropriate process lifetime management.

The service must continue to enforce permissions even if the MCP client is malicious or compromised.

### Platform details

macOS:

- Correct application signing and notarization.
- Keychain integration.
- Permission prompts.
- Apple Silicon and supported Intel builds.

Windows:

- Signed installers where distribution infrastructure permits.
- Windows Credential Manager or appropriate secure storage.
- Appropriate installer and uninstall behavior.

Linux:

- Supported package formats.
- Secret Service integration where available.
- X11/Wayland compatibility considerations.
- Clear limitations for global shortcuts or desktop integration.

Provide graceful degradation when OS functionality differs.

---

# PART XI — BACKEND AND API

## 40. Backend design

Organize backend modules around domain capabilities.

Suggested modules:

```text
auth
users
profiles
households
accounts
ledger
transactions
categories
merchants
budgets
planning
recurrence
currency
exchange-rates
forecasting
analytics
savings
imports
attachments
automation
notifications
sync
mcp
backups
admin
audit
```

Separate:

- HTTP transport.
- Authorization.
- Domain services.
- Persistence.
- External integrations.

Avoid exposing ORM entities directly as public API contracts.

Use migrations for all schema changes.

No automatic destructive schema synchronization in production.

## 41. API conventions

Use versioned endpoints.

Example:

```text
/api/v1/accounts
/api/v1/transactions
/api/v1/categories
/api/v1/budgets
/api/v1/plans
/api/v1/recurrences
/api/v1/goals
/api/v1/analytics
/api/v1/forecasts
/api/v1/imports
/api/v1/currencies
/api/v1/sync
/api/v1/devices
/api/v1/mcp
```

Use:

- Explicit validation.
- Consistent error formats.
- Cursor pagination where appropriate.
- Idempotency keys for important mutations.
- Request size limits.
- Structured audit records.
- API versioning.
- OpenAPI specifications.

## 42. Authentication and authorization

Support:

- Secure user registration where enabled.
- Authentication.
- Session management.
- Session revocation.
- Device management.
- Account recovery.
- Household membership.
- Profile authorization.
- MCP client authorization.

For self-hosted single-user deployments, provide simple setup without compromising core security.

Use secure password hashing.

Use appropriate CSRF protection for cookie-authenticated endpoints.

Validate all user-controlled identifiers against authenticated ownership.

Do not rely only on frontend access checks.

Support configurable registration policies for self-hosted servers.

---

# PART XII — ANALYTICS AND FORECASTING ENGINE

## 43. Financial calculations

Implement financial calculations as pure, deterministic domain functions whenever possible.

Define:

- Account balance calculation.
- Balance history.
- Net cash flow.
- Income aggregation.
- Expense aggregation.
- Category aggregation.
- Savings rate.
- Subscription annualization.
- Budget utilization.
- Budget rollover.
- Available-to-spend.
- Recurrence expansion.
- Forecast projection.
- Goal completion projection.
- FX conversion and valuation.
- Refund handling.
- Reconciliation.

Use shared tests against common fixtures.

The Go backend and TypeScript client must produce equivalent results for relevant calculations.

Where authoritative server computations differ from client cache calculations, define the rules explicitly.

## 44. Forecasting details

A useful forecast must operate on dated financial events.

Inputs:

- Account starting balances.
- Future income.
- Future expenses.
- Recurrence schedules.
- Planned expenses.
- Transfer schedules.
- Installments.
- Savings contributions.
- Currency assumptions.
- Financial reserves.
- Confidence levels.

Outputs:

- Daily projected balances.
- Total available balance.
- Lowest projected balance.
- Upcoming shortfalls.
- Conservative forecast.
- Optimistic forecast.
- Expected month-end balance.
- Safe-to-spend amount.

Do not simply subtract all monthly expenses from monthly income and call it a daily forecast.

Ensure planned transactions already matched to actual transactions are not counted again.

Provide explicit assumptions.

---

# PART XIII — SECURITY

## 45. Security requirements

Apply secure development practices throughout the project.

### Input validation

Validate all API requests, imported files, and MCP tool arguments.

### Authorization

Enforce object-level authorization for every financial resource.

### SQL safety

Use parameterized queries.

Never expose arbitrary SQL execution through MCP.

### File uploads

Validate file types, sizes, and contents.

Protect against path traversal, decompression bombs, malformed documents, and parser resource exhaustion.

### Template execution

Do not evaluate arbitrary user input as code.

Do not allow template injection.

Sandbox custom code adapters where supported.

### Secrets

Keep secrets out of source control and application logs.

Use environment-based configuration and secure storage.

### Encryption

Use established cryptographic libraries and tested constructions.

### Logging

Redact passwords, tokens, authentication headers, raw financial attachments, and unnecessary personal information.

### Rate limiting

Protect authentication, synchronization, imports, and MCP endpoints.

### Supply chain

Use lockfiles, dependency scanning, and CI security checks.

### Auditability

Track privileged changes without exposing unnecessary sensitive information.

---

# PART XIV — TESTING

## 46. Test strategy

Every significant feature must have appropriate automated tests.

Use:

- Unit tests.
- Domain invariant tests.
- Integration tests.
- API tests.
- Database tests.
- Importer fixture tests.
- Synchronization tests.
- Security tests.
- End-to-end browser tests.
- Native platform tests.
- Accessibility tests.
- Performance tests.

### Critical financial test cases

Test at least:

1. Expense creation updates balance correctly.
2. Income creation updates balance correctly.
3. Transfers do not inflate income.
4. Transfers do not inflate expenses.
5. Split totals remain exact.
6. Refunds are handled correctly.
7. Credit card payments are not double-counted.
8. FX calculations follow rounding rules.
9. Historical conversion rates are preserved.
10. Budgets calculate actual and planned spending separately.
11. Recurring schedules handle month boundaries.
12. Forecasts detect mid-month negative balances.
13. Planned expenses are not double-counted after matching.
14. Duplicate imports are recognized.
15. Imported source records remain intact.
16. Reprocessing imports preserves user categories.
17. Rollbacks do not remove unrelated transactions.
18. Opening balances reconcile correctly.
19. Timezone changes do not corrupt transaction dates.
20. Concurrent sync updates do not corrupt financial totals.
21. Interrupted sync operations recover.
22. Offline edits survive restarts.
23. Encryption and decryption work across devices.
24. Invalid MCP writes are rejected.
25. Read-only MCP clients cannot mutate data.

### Browser testing

Use Playwright.

Test real user journeys:

- Complete onboarding.
- Create accounts.
- Add income.
- Add expenses.
- Create budgets.
- Create planned expenses.
- Simulate future balances.
- Import synthetic statements.
- Split transactions.
- Run analytics.
- Switch reporting currency.
- Enable synchronization.
- Work offline.
- Reconnect.
- Restore a backup.
- Use MCP administration.

Interact with the actual running application.

Screenshots are useful for visual review but do not replace functional assertions.

### Performance

Test with realistic synthetic datasets:

- Thousands of transactions.
- Tens of thousands of transactions.
- Multiple years of historical records.
- Numerous recurring expenses.
- Multiple accounts.
- Several currencies.
- Large import batches.

Ensure analytics, filtering, and forecasts remain responsive.

Avoid excessive rerendering and full-data loading.

---

# PART XV — DEPLOYMENT AND OPERATIONS

## 47. Docker setup

Provide Docker Compose suitable for self-hosting.

The default deployment must support:

- Go backend.
- PostgreSQL.
- Web frontend.
- Persistent volumes.
- Environment configuration.
- Health checks.
- Database migrations.
- HTTPS through a documented reverse-proxy setup.
- Backup and restore scripts.

Prefer a simple single-server deployment.

Provide separate development and production configuration.

Do not expose PostgreSQL publicly by default.

Use non-root containers where practical.

Document resource requirements.

### Example deployment concept

```text
Internet / LAN
       |
   Reverse Proxy
       |
   ┌───┴────────┐
   │            │
Web Frontend   Go API
                |
           PostgreSQL
                |
       Backup / Storage
```

The backend must be able to serve all connected clients without platform-specific server deployments.

## 48. Configuration

Provide an example environment file documenting:

- API host.
- Public URL.
- Database configuration.
- Authentication settings.
- Registration policy.
- Attachment storage.
- Currency rate providers.
- Background tasks.
- SMTP or other optional notifications.
- Backup configuration.
- MCP settings.
- Logging.
- Rate limits.

Never commit live credentials.

---

# PART XVI — DEVELOPMENT PROCESS

## 49. Maintain progress tracking

Create:

```text
docs/implementation-status.md
```

Track all 145 features.

For each feature, record:

- Feature number.
- Name.
- Target platform(s).
- Implementation phase.
- Status.
- Dependencies.
- Tests.
- Known limitations.

Valid statuses:

```text
NOT_STARTED
IN_PROGRESS
IMPLEMENTED
TESTED
BLOCKED_EXTERNAL
DEFERRED_TO_PHASE
```

Do not confuse DEFERRED_TO_PHASE with complete.

Mark Raiffeisen-specific parsing BLOCKED_EXTERNAL until the actual statement format is provided.

Mark native desktop MCP as DEFERRED_TO_PHASE until desktop development.

## 50. Agent instructions

Create complete project instruction files.

### AGENTS.md

Document:

- Repository structure.
- Development commands.
- Code standards.
- Architecture.
- Testing requirements.
- Financial invariants.
- Migration guidelines.
- Security rules.
- Definition of done.

### CLAUDE.md

Provide equivalent instructions suitable for Claude Code.

Reference shared documentation rather than maintaining conflicting rules.

### Context preservation

Maintain:

```text
docs/architecture/decisions/
docs/implementation-status.md
docs/known-issues.md
docs/next-steps.md
```

This allows development to continue across multiple AI sessions without losing project context.

---

## 51. Definition of done

A feature is complete only when:

1. The implementation exists.
2. It uses real data.
3. Validation works.
4. Error handling exists.
5. Authorization is enforced where applicable.
6. Financial invariants hold.
7. The interface works.
8. Tests pass.
9. Relevant documentation exists.
10. It has been functionally verified.

Do not implement a UI that displays fake balances and label it complete.

Do not leave major features as TODO comments while marking them implemented.

Do not claim a platform was tested unless it was actually built and tested on that platform or a supported testing environment.

Clearly distinguish implemented, tested, blocked, and deferred functionality.

---

# PART XVII — EXECUTION SEQUENCE

## 52. Detailed implementation order

Follow this sequence.

### Milestone 1 — Project foundation

- Monorepo.
- Development environment.
- Docker infrastructure.
- Backend skeleton.
- Shared types.
- Test infrastructure.
- API contracts.
- Database design.
- Financial invariants.

### Milestone 2 — Core financial backend

- Users and profiles.
- Accounts.
- Ledger.
- Expenses.
- Income.
- Transfers.
- Categories.
- Tags.
- Merchants.
- Splits.
- Attachments metadata.
- Currency engine.
- Exchange rates.
- Balance calculations.

### Milestone 3 — Planning backend

- Planned expenses.
- Recurring expenses.
- Recurring income.
- Subscriptions.
- Installments.
- Budgets.
- Rollover.
- Savings goals.
- Reminders.
- Matching planned and actual transactions.

### Milestone 4 — Analytics backend

- Aggregations.
- Comparisons.
- Forecasts.
- Savings rate.
- Cash flow.
- Net worth.
- Anomaly detection.
- Reporting.
- Simulation.

### Milestone 5 — Import infrastructure

- Importer SDK.
- Generic formats.
- Statement staging.
- Parsing warnings.
- Preview.
- Deduplication.
- Reconciliation.
- Rollback.
- Historical coverage.
- Templates.
- Community contribution structure.
- Raiffeisen extension placeholder.

### Milestone 6 — Synchronization and security

- Authentication.
- Devices.
- Incremental synchronization.
- Offline changes.
- Conflict resolution.
- Encryption architecture.
- Backup and restore.
- Household authorization.
- Profile management.

### Milestone 7 — Remote MCP

- MCP endpoint.
- Read-only tools.
- Permission model.
- Scoped access.
- Write proposals.
- Approval enforcement.
- Audit logs.
- Documentation.

### Milestone 8 — Web application foundation

- React application.
- Local persistence.
- Connected persistence.
- Application shell.
- First-launch wizard.
- Themes.
- Localization.
- Accessibility.
- Navigation.
- Auth and sync setup.

### Milestone 9 — Web financial workflows

- Accounts.
- Transactions.
- Expense entry.
- Split editor.
- Import center.
- Categorization.
- Budgets.
- Planning.
- Recurring payments.
- Subscriptions.
- Savings goals.
- Currency converter.

### Milestone 10 — Web analytics and advanced workflows

- Dashboard.
- Reports.
- Charts.
- Forecast simulator.
- Historical coverage.
- Rules.
- Notifications.
- Reconciliation.
- Backup management.
- MCP administration.
- Household management.

### Milestone 11 — Web verification

Run full browser tests and security checks.

Fix all critical and high-severity defects.

Verify local-only and connected modes independently.

Verify offline operation.

Verify historical import with synthetic statements.

Do not proceed to mobile until the web application provides a reliable reference implementation.

### Milestone 12 — Android and iOS

- Initialize Tauri mobile applications.
- Integrate native SQLite.
- Adapt UI.
- Implement receipt capture.
- Implement biometric lock.
- Implement notifications.
- Implement local imports.
- Implement synchronization.
- Test Android.
- Test iOS.
- Address platform-specific issues.

### Milestone 13 — macOS, Windows, Linux

- Initialize desktop Tauri applications.
- Integrate SQLite.
- Native file handling.
- System tray.
- Shortcuts.
- Native notifications.
- Secure storage.
- Automatic updates.
- Local MCP.
- Packaging.
- Platform testing.

### Milestone 14 — Full project hardening

- Cross-platform consistency.
- Security audit.
- Performance optimization.
- Backup recovery.
- Sync recovery.
- Encryption verification.
- Documentation.
- Installation guides.
- Release artifacts.
- Feature checklist completion.

---

# PART XVIII — ADDITIONAL DESIGN REQUIREMENTS

## 53. Handle real-world financial complexity

Account for:

- Delayed bank postings.
- Pending card transactions.
- Different transaction dates.
- Currency conversion markups.
- Partial refunds.
- Reimbursements.
- Chargebacks.
- Credit card balances.
- Loan payments.
- Transfers between currencies.
- Account balance corrections.
- Missing statement periods.
- Duplicate imports.
- Historical edits.
- Irregular recurring payments.
- Recurrence termination.
- Subscription price changes.
- Changed exchange rates.
- Deleted accounts with historical records.
- Profile transfers.
- Incomplete category information.
- Receipts missing from imported transactions.

Never silently infer a fact that cannot be established from available data.

## 54. Historical data use case

The initial real-world historical import target is:

**Raiffeisen Bank BiH statements dating from December 2024 onward.**

The application must allow historical data to be explored immediately after import.

The user should be able to:

- View spending by month.
- Compare entire years.
- Identify large purchases.
- Find subscriptions.
- Categorize old transactions.
- Split old transactions.
- Correct classifications.
- Inspect original statement values.
- Attach supporting receipts.
- Run forecasts using historical spending averages.
- Ask AI agents questions through MCP.

The initial Raiffeisen-specific parser will be implemented once format examples are available.

Until then, generic import infrastructure and synthetic tests must be fully functional.

## 55. Open-source community design

Make it easy for contributors to add:

- Banks.
- Import templates.
- Translations.
- Currency providers.
- Export formats.
- Analytics views.
- UI improvements.
- MCP tools.
- Integrations.

Provide documented interfaces and fixture-based testing.

Avoid an uncontrolled plugin system with unrestricted access to financial records.

## 56. Avoid unnecessary external dependencies

The application must not require:

- Paid AI subscriptions.
- A proprietary cloud service.
- Bank API access.
- Online analytics.
- A mandatory user account.
- A third-party subscription to access personal financial data.

External integrations should be replaceable.

---

# PART XIX — FINAL ACCEPTANCE CRITERIA

The final implementation is acceptable when:

### Backend

- Financial operations are correct.
- APIs are documented.
- Authentication is secure.
- Synchronization works.
- MCP works.
- Import infrastructure works.
- Database migrations work.
- Self-hosted deployment works.

### Web

- Users can start in local mode.
- Users can connect to a backend.
- Local and connected modes both function.
- All web-relevant finance workflows work.
- Analytics use real data.
- Forecasts calculate correctly.
- Imports are editable and auditable.
- Browser E2E tests pass.
- The application works offline within documented browser limitations.

### Mobile

- Android and iOS apps work with the shared backend.
- Offline financial data works.
- Mobile expense entry is fast.
- Native integrations are functional.
- Synchronization is reliable.

### Desktop

- macOS, Windows, and Linux builds exist.
- Local SQLite works.
- Native functionality works.
- Local MCP works.
- Offline operation works.
- Synchronization works.
- Packaging and updates are documented.

### Financial accuracy

- No unexplained rounding errors.
- No duplicate postings.
- No double-counted transfers.
- No invalid split totals.
- No unexplained balance changes.
- No inconsistent reporting currency conversions.
- No silent data loss during synchronization.
- No silent corruption during imports.

### Documentation

- Installation guide.
- Self-hosting guide.
- Developer guide.
- Contributor guide.
- Bank importer guide.
- MCP integration guide.
- API documentation.
- Security documentation.
- Backup and recovery guide.
- Platform build guide.
- Feature implementation checklist.

---

# PART XX — FINAL INSTRUCTIONS TO THE IMPLEMENTING AGENT

Start with Phase 0, then proceed to the backend and complete web application.

Do not start mobile or desktop development prematurely.

However, do not make architectural choices that prevent those platforms from being implemented later.

The backend and web application must already support local-first data ownership, optional synchronization, banking imports, complete analytics, and MCP integration.

The finance engine must be deterministic, reusable, testable, and independent of presentation details.

Use the existing technical preferences:

- Go backend.
- React + TypeScript frontend.
- Tauri 2 for native clients.
- PostgreSQL backend database.
- SQLite for native local storage.
- IndexedDB-compatible web local storage.
- Bun package management.
- Dockerized infrastructure.
- Self-hostable backend.
- Open-source architecture.

Build polished, complete interfaces.

Do not use placeholder buttons or nonfunctional UI elements.

Avoid fake data except in explicitly labeled demos and automated test fixtures.

Verify interactions in the browser.

Document technical decisions and maintain accurate implementation status.

Where implementation work exceeds one session, preserve the exact project state, remaining tasks, and acceptance criteria in repository documentation so another agent can continue.

Do not compromise the project's financial correctness, security, or data ownership requirements merely to report faster completion.

**The goal is a complete, secure, extensible financial management system—not just an expense table with some charts.**

Begin implementation.

