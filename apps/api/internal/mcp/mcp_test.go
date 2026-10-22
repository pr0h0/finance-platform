package mcp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/mcp"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

type env struct {
	t                     *testing.T
	pool                  *pgxpool.Pool
	cfg                   *config.Config
	url                   string
	user, profile         uuid.UUID
	human                 string // bearer session token of the user
	acc1, acc2, groceries uuid.UUID
	tx1, tx2              uuid.UUID
}

func newEnv(t *testing.T) *env {
	pool := testdb.New(t)
	e := &env{t: t, pool: pool}
	e.user, e.profile = testdb.SeedUserProfile(t, pool)
	e.cfg = &config.Config{MCPEnabled: true, MCPMaxResults: 500, MaxBodyBytes: 1 << 20, RateLimitMCPPM: 10000}
	deps := &app.Deps{Config: e.cfg, DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	r := chi.NewRouter()
	r.Use(middleware.RequestID, httpx.MaxBody(1<<20), auth.Middleware(deps))
	r.Route("/api/v1", func(v chi.Router) { mcp.Register(v, deps) })
	r.Route("/mcp", func(m chi.Router) { mcp.RegisterTransport(m, deps) })
	mcp.RegisterOAuth(r, deps)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	e.url = srv.URL
	e.cfg.PublicURL = srv.URL // OAuth issuer and token audience (<PUBLIC_URL>/mcp)
	tok, hash := auth.NewToken()
	e.human = tok
	e.exec(`INSERT INTO sessions (user_id, token_hash, kind, expires_at) VALUES ($1,$2,'bearer', now() + interval '1 day')`, e.user, hash)
	e.acc1, e.acc2, e.groceries = uuid.New(), uuid.New(), uuid.New()
	e.exec(`INSERT INTO accounts (id, profile_id, name, account_type, currency) VALUES ($1,$2,'Checking','checking','BAM'), ($3,$2,'Card','credit_card','BAM')`, e.acc1, e.profile, e.acc2)
	e.exec(`INSERT INTO categories (id, profile_id, name) VALUES ($1,$2,'Groceries')`, e.groceries, e.profile)
	e.tx1 = e.expense(e.acc1, "2026-10-05", "150.00", "Supermarket")
	e.tx2 = e.expense(e.acc2, "2026-10-06", "40.00", "Pharmacy")
	return e
}

func (e *env) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(context.Background(), sql, args...); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
}

func (e *env) scalar(sql string, args ...any) string {
	e.t.Helper()
	var s *string
	if err := e.pool.QueryRow(context.Background(), sql, args...).Scan(&s); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
	if s == nil {
		return "<nil>"
	}
	return *s
}

func (e *env) expense(acc uuid.UUID, date, amount, desc string) uuid.UUID {
	id := uuid.New()
	e.exec(`INSERT INTO transactions (id, profile_id, kind, booking_date, description) VALUES ($1,$2,'expense',$3,$4)`, id, e.profile, date, desc)
	e.exec(`INSERT INTO postings (profile_id, transaction_id, account_id, amount, currency) VALUES ($1,$2,$3,-$4::numeric,'BAM')`, e.profile, id, acc, amount)
	e.exec(`INSERT INTO transaction_splits (profile_id, transaction_id, amount, currency) VALUES ($1,$2,$3,'BAM')`, e.profile, id, amount)
	return id
}

func (e *env) http(method, path, bearer string, body any) (int, map[string]any) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.url+path, rd)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Profile-ID", e.profile.String())
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = map[string]any{"raw": string(raw)}
	}
	return res.StatusCode, out
}

// newClient creates an MCP client through the REST API (as the human) and sets its grants.
func (e *env) newClient(grants ...map[string]any) (id, token string) {
	e.t.Helper()
	st, c := e.http("POST", "/api/v1/mcp/clients", e.human, map[string]any{"name": "Claude"})
	if st != 201 {
		e.t.Fatalf("create client %d %v", st, c)
	}
	id, token = c["id"].(string), c["token"].(string)
	if !strings.HasPrefix(token, mcp.TokenPrefix) {
		e.t.Fatalf("token %q", token)
	}
	for _, g := range grants {
		g["profileId"] = e.profile
	}
	if st, b := e.http("PUT", "/api/v1/mcp/clients/"+id+"/grants", e.human, map[string]any{"grants": grants}); st != 200 {
		e.t.Fatalf("grants %d %v", st, b)
	}
	return id, token
}

var rpcID = 0

// call invokes an MCP tool over Streamable HTTP (JSON-RPC) and returns the structured result.
func (e *env) call(token, tool string, args any) (map[string]any, bool) {
	e.t.Helper()
	rpcID++
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": rpcID, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": args}})
	st, raw := e.rpc(token, body)
	if st != 200 {
		e.t.Fatalf("%s: HTTP %d %s", tool, st, raw)
	}
	var res struct {
		Result struct {
			StructuredContent map[string]any `json:"structuredContent"`
			IsError           bool           `json:"isError"`
		} `json:"result"`
		Error any `json:"error"`
	}
	if err := json.Unmarshal(raw, &res); err != nil || res.Error != nil {
		e.t.Fatalf("%s: %v %s", tool, err, raw)
	}
	return res.Result.StructuredContent, res.Result.IsError
}

func (e *env) rpc(token string, body []byte) (int, []byte) {
	req, _ := http.NewRequest("POST", e.url+"/mcp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-06-18")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, raw
}

func errCode(r map[string]any) string {
	e, _ := r["error"].(map[string]any)
	s, _ := e["code"].(string)
	return s
}

func (e *env) category(tx uuid.UUID) string {
	return e.scalar(`SELECT category_id::text FROM transaction_splits WHERE transaction_id = $1 AND deleted_at IS NULL`, tx)
}

func TestProtocolAndReadTools(t *testing.T) {
	e := newEnv(t)
	_, tok := e.newClient(map[string]any{"scope": "read_aggregates"}, map[string]any{"scope": "read_transactions"})

	// initialize + tools/list over the real Streamable HTTP transport.
	st, raw := e.rpc(tok, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`))
	if st != 200 || !bytes.Contains(raw, []byte(`"finance-platform"`)) {
		t.Fatalf("initialize %d %s", st, raw)
	}
	st, raw = e.rpc(tok, []byte(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`))
	var list struct {
		Result struct {
			Tools []map[string]any `json:"tools"`
		} `json:"result"`
	}
	if json.Unmarshal(raw, &list); st != 200 || len(list.Result.Tools) != 31 {
		t.Fatalf("tools/list %d: %d tools %s", st, len(list.Result.Tools), raw)
	}

	r, isErr := e.call(tok, "list_transactions", map[string]any{"limit": 1})
	if isErr || len(r["transactions"].([]any)) != 1 || r["meta"].(map[string]any)["nextCursor"] == nil {
		t.Fatalf("list_transactions %v", r)
	}
	r, isErr = e.call(tok, "list_transactions", map[string]any{"search": "pharm"})
	if isErr || len(r["transactions"].([]any)) != 1 {
		t.Fatalf("search %v", r)
	}
	r, isErr = e.call(tok, "get_financial_overview", map[string]any{"asOf": "2026-10-21"})
	if isErr {
		t.Fatalf("overview %v", r)
	}
	// checking -150 (asset), card owes 40 (liability): net worth -190, never double-counted.
	if r["netWorth"].(map[string]any)["amount"] != "-190.00" || r["totalLiabilities"].(map[string]any)["amount"] != "40.00" ||
		r["monthExpenses"].(map[string]any)["amount"] != "190.00" {
		t.Fatalf("overview %v", r)
	}
	r, isErr = e.call(tok, "get_spending_by_category", map[string]any{"dateFrom": "2026-10-01", "dateTo": "2026-10-31"})
	if isErr || r["total"].(map[string]any)["amount"] != "190.00" {
		t.Fatalf("spending %v", r)
	}
	if r, isErr = e.call(tok, "get_uncategorized_transactions", map[string]any{}); isErr || len(r["transactions"].([]any)) != 2 {
		t.Fatalf("inbox %v", r)
	}
	if r, isErr = e.call(tok, "get_cash_flow_forecast", map[string]any{"days": 10}); isErr || len(r["days"].([]any)) == 0 {
		t.Fatalf("forecast %v", r)
	}
	if r, isErr = e.call(tok, "simulate_expense", map[string]any{"amount": map[string]any{"amount": "500.00", "currency": "BAM"}, "date": e.today()}); isErr {
		t.Fatalf("simulate %v", r)
	}
	for _, tool := range []string{"list_accounts", "get_income_summary", "get_budget_status", "list_recurring_expenses", "list_planned_expenses",
		"get_savings_goals", "get_currency_exposure", "get_import_coverage"} {
		if r, isErr := e.call(tok, tool, map[string]any{}); isErr {
			t.Errorf("%s: %v", tool, r)
		}
	}
	// Schema validation: amounts must be decimal strings, unknown fields are rejected.
	if r, isErr := e.call(tok, "list_transactions", map[string]any{"minAmount": 5}); !isErr {
		t.Fatalf("numeric amount accepted %v", r)
	}
	if r, isErr := e.call(tok, "list_accounts", map[string]any{"bogus": true}); !isErr {
		t.Fatalf("unknown field accepted %v", r)
	}
	// Every call is audited.
	if n := e.scalar(`SELECT count(*)::text FROM audit_log WHERE action = 'mcp.tool_call' AND actor_type = 'mcp'`); n == "0" {
		t.Fatal("tool calls not audited")
	}
}

func (e *env) today() string {
	return e.scalar(`SELECT (now() AT TIME ZONE 'Europe/Sarajevo')::date::text`)
}

// PLAN §46 case 25: read-only MCP clients cannot mutate data.
func TestReadOnlyClientCannotWrite(t *testing.T) {
	e := newEnv(t)
	_, tok := e.newClient(map[string]any{"scope": "read_aggregates"}, map[string]any{"scope": "read_transactions"})
	before := e.scalar(`SELECT sync_version::text FROM profiles WHERE id = $1`, e.profile)
	for tool, args := range map[string]any{
		"update_transaction_category": map[string]any{"transactionId": e.tx1, "categoryId": e.groceries},
		"split_transaction":           map[string]any{"transactionId": e.tx1, "splits": []any{map[string]any{"categoryId": e.groceries, "amount": map[string]any{"amount": "150.00", "currency": "BAM"}}}},
		"create_budget":               map[string]any{"name": "x", "periodType": "monthly", "startDate": "2026-10-01", "currency": "BAM", "allocations": []any{}},
		"create_savings_goal":         map[string]any{"name": "x", "targetAmount": map[string]any{"amount": "10.00", "currency": "BAM"}},
	} {
		r, isErr := e.call(tok, tool, args)
		if !isErr || errCode(r) != "scope_missing" {
			t.Errorf("%s: %v", tool, r)
		}
	}
	if r, _ := e.call(tok, "preview_changes", map[string]any{"calls": []any{map[string]any{"tool": "update_transaction_category",
		"arguments": map[string]any{"transactionId": e.tx1, "categoryId": e.groceries}}}}); r["results"].([]any)[0].(map[string]any)["valid"] != false {
		t.Fatalf("preview for read-only client %v", r)
	}
	if after := e.scalar(`SELECT sync_version::text FROM profiles WHERE id = $1`, e.profile); after != before {
		t.Fatal("read-only client changed data")
	}
	if n := e.scalar(`SELECT count(*)::text FROM mcp_proposed_changes`); n != "0" {
		t.Fatal("read-only client created proposals")
	}
}

// PLAN §46 case 24: invalid MCP writes are rejected; approvals are enforced server-side.
func TestWriteProposalsApprovalAndInvalidWrites(t *testing.T) {
	e := newEnv(t)
	_, tok := e.newClient(map[string]any{"scope": "read_transactions"}, map[string]any{"scope": "edit_categories"},
		map[string]any{"scope": "edit_splits"}, map[string]any{"scope": "edit_metadata", "approval": "auto"})

	// Invalid writes: splits that do not sum, unknown category, foreign transaction, wrong currency.
	bad := []struct {
		tool string
		args map[string]any
	}{
		{"split_transaction", map[string]any{"transactionId": e.tx1, "splits": []any{
			map[string]any{"categoryId": e.groceries, "amount": map[string]any{"amount": "100.00", "currency": "BAM"}},
			map[string]any{"categoryId": nil, "amount": map[string]any{"amount": "49.99", "currency": "BAM"}}}}},
		{"split_transaction", map[string]any{"transactionId": e.tx1, "splits": []any{map[string]any{"categoryId": nil, "amount": map[string]any{"amount": "150.00", "currency": "EUR"}}}}},
		{"split_transaction", map[string]any{"transactionId": e.tx1, "splits": []any{map[string]any{"categoryId": nil, "amount": map[string]any{"amount": "150.001", "currency": "BAM"}}}}},
		{"update_transaction_category", map[string]any{"transactionId": e.tx1, "categoryId": uuid.New()}},
		{"update_transaction_category", map[string]any{"transactionId": uuid.New(), "categoryId": e.groceries}},
		{"update_transaction_category", map[string]any{"transactionId": "not-a-uuid", "categoryId": e.groceries}},
	}
	for i, b := range bad {
		if r, isErr := e.call(tok, b.tool, b.args); !isErr {
			t.Errorf("bad write %d accepted: %v", i, r)
		}
	}
	if n := e.scalar(`SELECT count(*)::text FROM mcp_proposed_changes`); n != "0" {
		t.Fatalf("invalid writes created %s proposals", n)
	}

	// A valid categorization becomes a pending proposal; nothing changes until a human approves.
	r, isErr := e.call(tok, "update_transaction_category", map[string]any{"transactionId": e.tx1, "categoryId": e.groceries, "idempotencyKey": "k1"})
	if isErr || r["status"] != "pending" {
		t.Fatalf("proposal %v", r)
	}
	pid := r["proposalId"].(string)
	if r2, _ := e.call(tok, "update_transaction_category", map[string]any{"transactionId": e.tx1, "categoryId": e.groceries, "idempotencyKey": "k1"}); r2["proposalId"] != pid {
		t.Fatalf("idempotent retry created a new proposal %v", r2)
	}
	if e.category(e.tx1) != "<nil>" {
		t.Fatal("proposal changed data before approval")
	}
	r, _ = e.call(tok, "apply_approved_changes", map[string]any{"proposalIds": []string{pid}})
	if r["results"].([]any)[0].(map[string]any)["status"] != "not_approved" {
		t.Fatalf("agent applied its own proposal: %v", r)
	}
	// The MCP token cannot approve through REST (auth never accepts MCP tokens on /api/v1).
	if st, _ := e.http("POST", "/api/v1/mcp/proposals/"+pid+"/approve", tok, nil); st != 401 {
		t.Fatalf("MCP token approved via REST: %d", st)
	}
	if st, b := e.http("POST", "/api/v1/mcp/proposals/"+pid+"/approve", e.human, nil); st != 200 || b["status"] != "approved" {
		t.Fatalf("approve %d %v", st, b)
	}
	r, _ = e.call(tok, "apply_approved_changes", map[string]any{"proposalIds": []string{pid}})
	if r["results"].([]any)[0].(map[string]any)["status"] != "applied" || e.category(e.tx1) != e.groceries.String() {
		t.Fatalf("apply %v cat=%s", r, e.category(e.tx1))
	}
	if src := e.scalar(`SELECT categorization_source FROM transactions WHERE id = $1`, e.tx1); src != "mcp" {
		t.Fatalf("categorization_source %s", src)
	}
	if n := e.scalar(`SELECT count(*)::text FROM audit_log WHERE action = 'transaction.categorize' AND actor_type = 'mcp'`); n != "1" {
		t.Fatalf("applied change audit entries: %s", n)
	}

	// Exact split → proposal; the transaction changes meanwhile → apply fails as stale.
	r, _ = e.call(tok, "split_transaction", map[string]any{"transactionId": e.tx1, "splits": []any{
		map[string]any{"categoryId": e.groceries, "amount": map[string]any{"amount": "95.40", "currency": "BAM"}},
		map[string]any{"categoryId": nil, "amount": map[string]any{"amount": "54.60", "currency": "BAM"}}}})
	spid := r["proposalId"].(string)
	e.exec(`UPDATE transactions SET version = version + 1, notes = 'edited by user' WHERE id = $1`, e.tx1)
	if st, b := e.http("POST", "/api/v1/mcp/proposals/"+spid+"/approve?apply=true", e.human, nil); st != 200 || b["status"] != "failed" || !strings.Contains(fmt.Sprint(b["error"]), "stale") {
		t.Fatalf("stale apply %d %v", st, b)
	}

	// Pre-authorized low-risk capability applies immediately (and is still recorded).
	r, isErr = e.call(tok, "update_transaction_metadata", map[string]any{"transactionId": e.tx2, "notes": "vitamins"})
	if isErr || r["status"] != "applied" || e.scalar(`SELECT notes FROM transactions WHERE id = $1`, e.tx2) != "vitamins" {
		t.Fatalf("auto apply %v", r)
	}
	// Reject flow.
	r, _ = e.call(tok, "update_transaction_category", map[string]any{"transactionId": e.tx2, "categoryId": e.groceries})
	rp := r["proposalId"].(string)
	if st, b := e.http("POST", "/api/v1/mcp/proposals/"+rp+"/reject", e.human, nil); st != 200 || b["status"] != "rejected" {
		t.Fatalf("reject %d %v", st, b)
	}
	if st, _ := e.http("POST", "/api/v1/mcp/proposals/"+rp+"/approve", e.human, nil); st != 409 {
		t.Fatalf("approving a rejected proposal: %d", st)
	}
	// auto approval for money-affecting scopes is refused at grant time.
	cid, _ := e.newClient()
	if st, _ := e.http("PUT", "/api/v1/mcp/clients/"+cid+"/grants", e.human, map[string]any{"grants": []any{
		map[string]any{"profileId": e.profile, "scope": "edit_splits", "approval": "auto"}}}); st != 422 {
		t.Fatalf("auto approval for edit_splits allowed: %d", st)
	}
}

func TestScopeRestrictionsAndRevocation(t *testing.T) {
	e := newEnv(t)
	cid, tok := e.newClient(map[string]any{"scope": "read_transactions", "accountIds": []uuid.UUID{e.acc1}},
		map[string]any{"scope": "read_aggregates", "accountIds": []uuid.UUID{e.acc1}, "dateFrom": "2026-10-01", "dateTo": "2026-12-31"})
	r, _ := e.call(tok, "list_transactions", map[string]any{})
	if txs := r["transactions"].([]any); len(txs) != 1 || txs[0].(map[string]any)["id"] != e.tx1.String() {
		t.Fatalf("account restriction %v", r)
	}
	if r, isErr := e.call(tok, "get_transaction", map[string]any{"transactionId": e.tx2}); !isErr || errCode(r) != "not_found" {
		t.Fatalf("foreign-account transaction visible %v", r)
	}
	if r, isErr := e.call(tok, "list_transactions", map[string]any{"accountIds": []uuid.UUID{e.acc2}}); !isErr || errCode(r) != "account_not_granted" {
		t.Fatalf("explicit foreign account %v", r)
	}
	r, _ = e.call(tok, "get_spending_by_category", map[string]any{"dateFrom": "2026-01-01", "dateTo": "2026-10-31"})
	if r["total"].(map[string]any)["amount"] != "150.00" || len(r["meta"].(map[string]any)["warnings"].([]any)) == 0 {
		t.Fatalf("aggregates must be limited to granted account and period: %v", r)
	}
	if r, isErr := e.call(tok, "get_budget_status", map[string]any{}); !isErr || errCode(r) != "account_restricted" {
		t.Fatalf("budget status for restricted client %v", r)
	}
	// Disable, then revoke: the token stops working immediately.
	if st, _ := e.http("PATCH", "/api/v1/mcp/clients/"+cid, e.human, map[string]any{"enabled": false}); st != 200 {
		t.Fatal("disable")
	}
	if st, _ := e.rpc(tok, []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)); st != 401 {
		t.Fatalf("disabled client still works: %d", st)
	}
	if st, _ := e.http("DELETE", "/api/v1/mcp/clients/"+cid, e.human, nil); st != 204 {
		t.Fatal("revoke")
	}
	if n := e.scalar(`SELECT count(*)::text FROM mcp_permission_grants WHERE mcp_client_id = $1 AND revoked_at IS NULL`, cid); n != "0" {
		t.Fatal("grants survive revocation")
	}
	// MCP disabled server-wide.
	e.cfg.MCPEnabled = false
	_, tok2 := e.newClient(map[string]any{"scope": "read_aggregates"})
	if st, raw := e.rpc(tok2, []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)); st != 404 || !bytes.Contains(raw, []byte("mcp_disabled")) {
		t.Fatalf("disabled MCP: %d %s", st, raw)
	}
	// No token at all.
	e.cfg.MCPEnabled = true
	if st, _ := e.rpc("", []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)); st != 401 {
		t.Fatalf("anonymous MCP: %d", st)
	}
}

func TestPlanningBudgetGoalRuleWrites(t *testing.T) {
	e := newEnv(t)
	_, tok := e.newClient(map[string]any{"scope": "read_aggregates"}, map[string]any{"scope": "create_planned"},
		map[string]any{"scope": "edit_budgets"}, map[string]any{"scope": "edit_goals"}, map[string]any{"scope": "edit_rules"})
	bam := func(a string) map[string]any { return map[string]any{"amount": a, "currency": "BAM"} }
	approve := func(r map[string]any, isErr bool) map[string]any {
		t.Helper()
		if isErr || r["status"] != "pending" {
			t.Fatalf("proposal %v", r)
		}
		st, b := e.http("POST", "/api/v1/mcp/proposals/"+r["proposalId"].(string)+"/approve?apply=true", e.human, nil)
		if st != 200 || b["status"] != "applied" {
			t.Fatalf("apply %d %v", st, b)
		}
		return b["result"].(map[string]any)
	}
	plan := approve(e.call(tok, "create_planned_expense", map[string]any{"description": "Internet", "amount": bam("39.90"), "dueDate": "2026-11-05",
		"rrule": "FREQ=MONTHLY", "accountId": e.acc1, "categoryId": e.groceries}))
	approve(e.call(tok, "update_planned_expense", map[string]any{"plannedTransactionId": plan["id"], "amount": bam("42.00")}))
	if a := e.scalar(`SELECT amount::numeric(30,2)::text FROM planned_transactions WHERE id = $1`, plan["id"]); a != "42.00" {
		t.Fatalf("plan amount %s", a)
	}
	if r, isErr := e.call(tok, "list_recurring_expenses", map[string]any{}); isErr || len(r["items"].([]any)) != 1 {
		t.Fatalf("recurring %v", r)
	}
	budget := approve(e.call(tok, "create_budget", map[string]any{"name": "Monthly", "periodType": "monthly", "startDate": "2026-10-01", "currency": "BAM",
		"allocations": []any{map[string]any{"categoryId": e.groceries, "amount": bam("400.00")}}}))
	approve(e.call(tok, "update_budget", map[string]any{"budgetId": budget["id"], "name": "Household"}))
	if r, isErr := e.call(tok, "get_budget_status", map[string]any{}); isErr || r["budgets"].([]any)[0].(map[string]any)["name"] != "Household" {
		t.Fatalf("budget status %v", r)
	}
	approve(e.call(tok, "create_savings_goal", map[string]any{"name": "Vacation", "targetAmount": bam("1000.00")}))
	rule := approve(e.call(tok, "create_categorization_rule", map[string]any{"name": "Markets", "match": map[string]any{"field": "description", "op": "contains", "value": "market"},
		"categoryId": e.groceries}))
	if rule["actions"].([]any)[0].(map[string]any)["type"] != "set_category" {
		t.Fatalf("rule %v", rule)
	}
	if n := e.scalar(`SELECT count(*)::text FROM sync_changes WHERE entity_type IN ('planned_transactions','budgets','savings_goals','categorization_rules')`); n == "0" {
		t.Fatal("writes not recorded for sync")
	}
	// Invalid planning write (negative amount) is rejected before any proposal exists.
	if r, isErr := e.call(tok, "create_planned_expense", map[string]any{"description": "x", "amount": bam("-1.00"), "dueDate": "2026-11-05"}); !isErr {
		t.Fatalf("negative plan accepted %v", r)
	}
}
