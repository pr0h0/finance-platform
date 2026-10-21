# Remote MCP server (Features 132–145)

The Go API exposes a [Model Context Protocol](https://modelcontextprotocol.io) server so AI agents
(Claude Code, Claude Desktop, any MCP client) can analyse your finances and **propose** changes.
The local desktop MCP server (Feature 131) is DEFERRED to the desktop phase; it will use the same
tool contracts (`packages/mcp-contracts`).

> **Privacy:** everything an agent reads through MCP is sent to that agent's AI provider. Only grant
> what you are comfortable sharing. Nothing is sent anywhere unless you create a client and grant it.

## Endpoint and transport

| | |
|---|---|
| URL | `https://<your-server>/mcp` (e.g. `https://fin.pr0h0.me/mcp`) |
| Transport | Streamable HTTP, **stateless**, JSON responses (official Go SDK `modelcontextprotocol/go-sdk`) |
| Auth | `Authorization: Bearer fpm_…` (MCP client token; shown once at creation) |
| Server switch | `MCP_ENABLED=true` (default **false**: the endpoint answers 404 `mcp_disabled`) |
| Limits | `RATE_LIMIT_MCP_PER_MIN` (default 120), `MCP_MAX_RESULTS` rows per page (default 500), 512 KiB per tool result |

MCP tokens work **only** on `/mcp`. They are rejected on the REST API, so an agent can never approve
its own proposals or manage clients.

## Setting up a client

1. Enable MCP on the server (`MCP_ENABLED=true` in `.env`, restart the API).
2. In the web app: **Settings → AI agents → New client** (REST: `POST /api/v1/mcp/clients`). Copy the
   token — it is shown once. A new client has **no grants**: it can do nothing yet.
3. Add grants (REST: `PUT /api/v1/mcp/clients/{id}/grants`). Each grant is one capability on one profile,
   optionally restricted to accounts and a date range:

| scope | allows |
|---|---|
| `read_aggregates` | balances, spending/income summaries, budgets, forecasts, goals, coverage |
| `read_transactions` | individual transactions, the uncategorized inbox |
| `read_merchants` | per-merchant spending (together with `read_aggregates`) |
| `read_attachments` | reserved (no attachment tool yet) |
| `edit_categories` | `update_transaction_category`, `bulk_categorize_transactions` |
| `edit_splits` | `split_transaction` |
| `edit_metadata` | `update_transaction_metadata` (description, notes, tags, merchant — never amounts/dates) |
| `create_planned` | `create_planned_expense`, `update_planned_expense` |
| `edit_budgets` | `create_budget`, `update_budget` |
| `edit_goals` | `create_savings_goal` |
| `edit_rules` | `create_categorization_rule` |

   You can only grant what you have: read scopes need viewer, write scopes editor on the profile.

```json
PUT /api/v1/mcp/clients/{id}/grants
{"grants": [
  {"profileId": "…", "scope": "read_aggregates"},
  {"profileId": "…", "scope": "read_transactions", "accountIds": ["<checking>"], "dateFrom": "2024-12-01"},
  {"profileId": "…", "scope": "edit_categories", "approval": "auto"}
]}
```

4. Disable (`PATCH … {"enabled": false}`) or revoke (`DELETE /api/v1/mcp/clients/{id}`) at any time;
   grants are re-read on every request, so the effect is immediate.

### Claude Code

```sh
claude mcp add --transport http finance https://fin.pr0h0.me/mcp \
  --header "Authorization: Bearer fpm_XXXXXXXX"
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "finance": {
      "type": "http",
      "url": "https://fin.pr0h0.me/mcp",
      "headers": { "Authorization": "Bearer ${FINPLAT_MCP_TOKEN}" }
    }
  }
}
```

### Claude Desktop

Remote connectors added in the Claude Desktop UI cannot send a custom bearer header (this server has no OAuth
flow yet), so use the `mcp-remote` bridge in
`claude_desktop_config.json` instead:

```json
{
  "mcpServers": {
    "finance": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://fin.pr0h0.me/mcp", "--header", "Authorization:Bearer ${FINPLAT_MCP_TOKEN}"],
      "env": { "FINPLAT_MCP_TOKEN": "fpm_XXXXXXXX" }
    }
  }
}
```

### Raw HTTP (any client / debugging)

```sh
curl -s https://fin.pr0h0.me/mcp \
  -H 'Authorization: Bearer fpm_XXXXXXXX' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_spending_by_category","arguments":{"dateFrom":"2025-01-01","dateTo":"2025-01-31"}}}'
```

## Tools

Names, descriptions, required scopes and input schemas are generated from `packages/mcp-contracts`
into `apps/api/internal/mcp/tools.json` (`scripts/bun.sh run apps/api/internal/mcp/gen/tools.ts`) and
listed at `GET /api/v1/mcp/tools`. Arguments are validated against those JSON Schemas; unknown fields
are rejected; money is always `{"amount": "150.00", "currency": "BAM"}` (decimal strings, never numbers).

**Read (§28):** `get_financial_overview`, `list_accounts`, `get_account_balance`, `list_transactions`,
`get_transaction`, `get_spending_by_category`, `get_spending_by_merchant`, `compare_periods`,
`get_income_summary`, `get_budget_status`, `list_recurring_expenses`, `list_planned_expenses`,
`get_cash_flow_forecast`, `get_savings_goals`, `get_currency_exposure`, `get_import_coverage`,
`get_uncategorized_transactions`, `simulate_expense`. Aggregates are computed by the same analytics,
budget and forecasting engines as the app (transfers never counted as income/expense, splits counted once,
FX at booking-date rates).

Every result carries `meta`: `complete` (false when amounts lacked an exchange rate, a page was cut, or
data is otherwise partial), `warnings` (e.g. "dateFrom raised to the start of this client's granted
period"), `missingRates`, `nextCursor` (pass back as `cursor`).

**Write (§29):** `update_transaction_category`, `split_transaction`, `bulk_categorize_transactions`,
`update_transaction_metadata`, `create_planned_expense`, `update_planned_expense`, `create_budget`,
`update_budget`, `create_savings_goal`, `create_categorization_rule`, plus `preview_changes` and
`apply_approved_changes`.

## Approval workflow (enforced by the server)

```
agent: split_transaction(...)            -> {"proposalId": "...", "status": "pending", "preview": {...}}
user:  Settings → AI agents → Proposals   (POST /api/v1/mcp/proposals/{id}/approve[?apply=true] | /reject,
                                            POST /api/v1/mcp/proposals/approve-batch {"ids": [...]})
agent: apply_approved_changes([id])      -> {"results": [{"proposalId": "...", "status": "applied"}]}
```

- Each write is validated, scope-checked (profile, accounts, period) and **dry-run** in a rolled-back
  database transaction, so the preview is exactly what applying would do and invalid changes (split sums,
  unknown categories, foreign accounts, currency/scale errors) are rejected before a proposal exists.
- Proposals expire after 7 days. Applying re-validates under the client's current grants and fails with
  `stale proposal` if the target changed since it was proposed (version check).
- `approval: "auto"` on a grant pre-authorizes low-risk changes (only `edit_categories` and
  `edit_metadata`); they apply immediately and are still stored as `applied` proposals for the audit trail.
- `idempotencyKey` on write tools makes retries return the same proposal.
- Changes go through the owning modules (ledger, planning, budgets, savings, automation), so they are
  synced to every device and audited with `actor_type = mcp`.

## Scope restrictions (Feature 144)

- **Profile:** a client sees only profiles it has grants on (`profileId` is required when it has several).
- **Accounts:** results are limited to granted accounts; postings on other accounts (e.g. the other leg of a
  transfer) are removed; tools that cannot be limited to accounts (budget status, goals, budgets, rules)
  refuse with `account_restricted`.
- **Period:** date ranges are clamped to the grant (with a warning); current-state tools (balances,
  forecasts) refuse when today is outside the granted period.
- **Capability:** each tool needs all of its scopes on the profile.

## Audit (Feature 142)

`audit_log` records every tool call (`mcp.tool_call`: tool, arguments ≤ 4 KiB, ok/error code, duration,
result size), proposal creation, approval/rejection (by the user), application/failure, client
creation/update/revocation and grant changes. Data changes made through MCP are recorded with the MCP
client as actor.

## Errors

Tool failures are returned as MCP tool results with `isError: true` and
`{"error": {"code": "...", "message": "...", "details": {...}}}` so the model can correct itself:
`scope_missing`, `profile_not_granted`, `account_not_granted`, `account_restricted`, `period_not_granted`,
`no_grants`, `validation_failed` (`details.fields`), `not_found`, `splits_mismatch`, `conflict`,
`result_too_large`, `idempotency_key_reused`, `read_only_profile`.
