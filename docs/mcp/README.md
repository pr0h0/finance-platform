# Remote MCP server (Features 132–145)

The Go API exposes a [Model Context Protocol](https://modelcontextprotocol.io) server so AI agents
(Claude Code, Claude Desktop, any MCP client) can analyse your finances and **propose** changes.
The desktop app also has a **local MCP server** (Feature 131, read-only, no server needed): see
[Local MCP server](#local-mcp-server-desktop-app) at the end. Both use the same tool contracts
(`packages/mcp-contracts`).

> **Privacy:** everything an agent reads through MCP is sent to that agent's AI provider. Only grant
> what you are comfortable sharing. Nothing is sent anywhere unless you create a client and grant it.

## Endpoint and transport

| | |
|---|---|
| URL | `https://<your-server>/mcp` (e.g. `https://fin.pr0h0.me/mcp`) |
| Transport | Streamable HTTP, **stateless**, JSON responses (official Go SDK `modelcontextprotocol/go-sdk`) |
| Auth | **OAuth 2.1** (connectors: claude.ai, Claude Desktop, Claude Code `/mcp`) or a static `Authorization: Bearer fpm_…` client token |
| Server switch | `MCP_ENABLED=true` (default **false**: `/mcp`, `/oauth/*` and `/.well-known/oauth-*` answer 404 `mcp_disabled`) |
| Limits | `RATE_LIMIT_MCP_PER_MIN` (default 120), `MCP_MAX_RESULTS` rows per page (default 500), 512 KiB per tool result (+ one attachment ≤ 4 MiB); `/oauth/register`, `/oauth/token`, `/oauth/revoke` use `RATE_LIMIT_AUTH_PER_MIN` per IP |
| Protocol | versions 2024-11-05 … 2025-11-25 (and newer ones the SDK knows) negotiated in `initialize`; `MCP-Protocol-Version` header validated; no `Mcp-Session-Id` (stateless); `GET /mcp` → 405 `Allow: POST` (no server-initiated SSE stream) |

MCP tokens (static or OAuth) work **only** on `/mcp`. They are rejected on the REST API, so an agent can never
approve its own proposals or manage clients.

## OAuth 2.1 (remote connectors)

The server implements the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization):

| | |
|---|---|
| Protected resource metadata (RFC 9728) | `GET /.well-known/oauth-protected-resource/mcp` (also without `/mcp`); resource = `<PUBLIC_URL>/mcp`. A 401 from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="…"` |
| Authorization server metadata (RFC 8414) | `GET /.well-known/oauth-authorization-server`; issuer = `PUBLIC_URL` |
| Dynamic client registration (RFC 7591) | `POST /oauth/register` — public clients only (`token_endpoint_auth_method: none`); redirect URIs must be `https://…` or `http://localhost|127.0.0.1|[::1]…`, no fragment |
| Authorization | `GET /oauth/authorize` — `response_type=code`, PKCE **S256 required**, `resource` (RFC 8707) must be `<PUBLIC_URL>/mcp`, `redirect_uri` must match a registered one exactly (otherwise an error page, never a redirect). The browser is sent to the consent page `/agents/authorize` in the web app |
| Token | `POST /oauth/token` (form) — `authorization_code` (+ `code_verifier`) and `refresh_token`. Access tokens `fpa_…` live 1 hour and are bound to `<PUBLIC_URL>/mcp`; refresh tokens `fpr_…` live 30 days and **rotate** on every use; presenting a used refresh token (or a used code) revokes the whole grant |
| Revocation (RFC 7009) | `POST /oauth/revoke` (`token`, `client_id`) — revokes the access and refresh token of that grant |

Codes and tokens are stored as SHA-256 hashes only. `PUBLIC_URL` must be the public origin clients use
(e.g. `https://fin.pr0h0.me`), because it is the issuer and the token audience.

**Consent:** you must be signed in to the web app (server account). The consent page shows the client's
self-chosen name **and the host it will redirect to** — approve only connections you started. You pick the
profile, the capabilities (read-only by default: totals, transactions, merchants; attachments and every write
capability are opt-in) and optional account/date restrictions. Approving creates a connection in
**MCP connections** (badge *OAuth*; one connection per client and user — authorizing again replaces its
permissions on that profile). From then on it is an ordinary client: same grants, proposals/approvals, audit
(`mcp.oauth.authorize`, `mcp.client.create`, `mcp.tool_call`, …), disable switch and **Revoke** (kills its
tokens immediately; the agent must authorize again).

## Setting up a client

### claude.ai (custom connector) and Claude Desktop

1. Enable MCP on the server (`MCP_ENABLED=true`, `PUBLIC_URL=https://fin.pr0h0.me`, restart the API).
2. claude.ai → Settings → Connectors → **Add custom connector** → URL `https://fin.pr0h0.me/mcp`
   (leave OAuth client id/secret empty: the connector registers itself).
3. Click **Connect**: you land on the consent page of your server (sign in first if asked), choose profile
   and permissions, **Approve**. Connectors added on claude.ai are also available in Claude Desktop.

### Claude Code

OAuth (no token to copy):

```sh
claude mcp add --transport http finance https://fin.pr0h0.me/mcp
# then in Claude Code: /mcp → finance → Authenticate (opens the consent page in your browser)
```

Static token (scripts, CI, clients without OAuth):

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

### Static tokens

1. In the web app: **MCP connections → New client** (REST: `POST /api/v1/mcp/clients`). Copy the
   token — it is shown once. A new client has **no grants**: it can do nothing yet.
2. Add grants (REST: `PUT /api/v1/mcp/clients/{id}/grants`). Each grant is one capability on one profile,
   optionally restricted to accounts and a date range:

| scope | allows |
|---|---|
| `read_aggregates` | balances, spending/income summaries, budgets, forecasts, goals, coverage |
| `read_transactions` | individual transactions, the uncategorized inbox |
| `read_merchants` | per-merchant spending (together with `read_aggregates`) |
| `read_attachments` | `get_attachments`: receipt/statement metadata, and the file itself (images, PDFs ≤ 4 MiB) |
| `edit_categories` | `update_transaction_category`, `bulk_categorize_transactions` |
| `edit_splits` | `split_transaction` |
| `edit_metadata` | `update_transaction_metadata` (description, notes, tags, merchant — never amounts/dates) |
| `create_planned` | `create_planned_expense`, `update_planned_expense` |
| `edit_budgets` | `create_budget`, `update_budget` |
| `edit_goals` | `create_savings_goal` |
| `edit_rules` | `create_categorization_rule` |

   You can only grant what you have: read scopes need viewer, write scopes editor on the profile.
   End-to-end encrypted profiles cannot be granted at all (422; the server holds only ciphertext, so
   reads would be empty and writes would break the profile's devices); the consent page does not list them.
   The same rules apply to grants chosen on the OAuth consent page.

```json
PUT /api/v1/mcp/clients/{id}/grants
{"grants": [
  {"profileId": "…", "scope": "read_aggregates"},
  {"profileId": "…", "scope": "read_transactions", "accountIds": ["<checking>"], "dateFrom": "2024-12-01"},
  {"profileId": "…", "scope": "edit_categories", "approval": "auto"}
]}
```

3. Disable (`PATCH … {"enabled": false}`) or revoke (`DELETE /api/v1/mcp/clients/{id}`) at any time;
   grants are re-read on every request, so the effect is immediate.

### Other clients without OAuth support

Bridge with `mcp-remote` and a static token:

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
`get_income_summary` (per month and per top-level income category), `get_budget_status`, `list_recurring_expenses`, `list_planned_expenses`,
`get_cash_flow_forecast`, `get_savings_goals`, `get_currency_exposure`, `get_import_coverage`,
`get_uncategorized_transactions`, `simulate_expense`, `get_attachments` (metadata; with `attachmentId` +
`includeContent` the file as an MCP image / embedded PDF resource — not for end-to-end encrypted files). Aggregates are computed by the same analytics,
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
  A grant made before its profile became end-to-end encrypted answers every tool with `e2ee_profile`.
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

## Local MCP server (desktop app)

The Linux, Windows and macOS apps answer the 19 read tools from the data on that computer (local
profiles and connected-mode caches alike), without any server.

1. Finance Platform → Settings → General → **Local MCP server** → tick *Allow AI apps on this computer
   to read my data*. The card then shows the exact command for this install.
2. Add it to the client (stdio):
   ```sh
   claude mcp add finance-local -- "/path/to/finance-platform" --mcp
   ```
   or in `claude_desktop_config.json` / `.mcp.json`:
   ```json
   { "mcpServers": { "finance-local": { "command": "/path/to/finance-platform", "args": ["--mcp"] } } }
   ```
   Typical paths: Linux `/usr/bin/finplat-native` (.deb/.rpm) or the `.AppImage` file; macOS
   `/Applications/Finance Platform.app/Contents/MacOS/finplat-native`; Windows
   `C:\Program Files\Finance Platform\finplat-native.exe`.

How it works: `--mcp` starts a small relay instead of the app. It reads `<app config>/mcp.json`
(`{port, token}`, written with mode 0600 while the switch is on; Linux `~/.config/me.pr0h0.finplat`,
macOS `~/Library/Application Support/me.pr0h0.finplat`, Windows `%APPDATA%\me.pr0h0.finplat`),
connects to the running app on `127.0.0.1:<port>`, sends the token, then copies JSON-RPC lines both
ways (`apps/native/src-tauri/src/mcp.rs`). The app hands each message to the web app
(`apps/web/src/mcp/local-server.ts`, tools in `local-tools.ts`), which answers from the open
database. `profileId` defaults to the profile open in the app.

- The app must be running (the tray is enough) and unlocked; otherwise the relay or the request fails
  with a message saying so.
- Read-only. Write tools / proposals run on the server's `/mcp` only.
- No per-client tokens or grants: anything running as your OS user can use it while it is on (the same
  user could read the database file anyway). Turning it off closes the port and deletes `mcp.json`.
- Calls are not audited (the server audits its `/mcp`).

