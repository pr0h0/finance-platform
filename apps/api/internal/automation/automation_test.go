package automation

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin/fintest"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
	"github.com/pr0h0/finance-platform/apps/api/internal/transactions"
)

func init() {
	fin.Now = func() time.Time { return time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC) }
}

func category(t *testing.T, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id uuid.UUID) *uuid.UUID {
	t.Helper()
	var c *uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT category_id FROM transaction_splits WHERE transaction_id = $1 AND deleted_at IS NULL`, id).Scan(&c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestRulesApplyAndUndo(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register)
	acc := fintest.Account(t, pool, profile, "Checking", "checking", "BAM")
	groceries := fintest.Category(t, pool, profile, "Groceries", nil)
	other := fintest.Category(t, pool, profile, "Other", nil)
	a := fintest.Txn(t, pool, profile, "expense", "2026-10-01", acc, "-25.00", "BAM", nil, "KONZUM 123 SARAJEVO")
	b := fintest.Txn(t, pool, profile, "expense", "2026-10-02", acc, "-80.00", "BAM", nil, "konzum maxi")
	userSet := fintest.Txn(t, pool, profile, "expense", "2026-10-03", acc, "-10.00", "BAM", &other, "Konzum bar")
	_, _ = pool.Exec(context.Background(), `UPDATE transactions SET categorization_source = 'user' WHERE id = $1`, userSet)
	small := fintest.Txn(t, pool, profile, "expense", "2026-10-04", acc, "-3.00", "BAM", nil, "Konzum")

	api.Must(http.StatusUnprocessableEntity, "POST", "/rules", map[string]any{"name": "bad", "conditions": []map[string]any{{"field": "description", "op": "regex", "value": "(unclosed"}},
		"actions": []map[string]any{{"type": "set_category", "categoryId": groceries}}}, nil)
	var rule Rule
	api.Must(http.StatusCreated, "POST", "/rules", map[string]any{"name": "Konzum", "priority": 10,
		"conditions": []map[string]any{{"field": "description", "op": "contains", "value": "konzum"}, {"field": "amount", "op": "gte", "value": "5"}, {"field": "direction", "op": "equals", "value": "debit"}},
		"actions":    []map[string]any{{"type": "set_category", "categoryId": groceries}}}, &rule)

	var res ApplyResult
	api.Must(http.StatusOK, "POST", "/rules/"+rule.ID.String()+"/apply", map[string]any{"dryRun": true}, &res)
	if len(res.Matched) != 2 || res.Updated != 0 || category(t, pool, a) != nil {
		t.Fatalf("dry run: %+v", res)
	}
	api.Must(http.StatusOK, "POST", "/rules/"+rule.ID.String()+"/apply", map[string]any{}, &res)
	if res.Updated != 2 || res.ApplicationID == nil {
		t.Fatalf("apply: %+v", res)
	}
	if c := category(t, pool, a); c == nil || *c != groceries {
		t.Fatal("rule did not categorize a")
	}
	if c := category(t, pool, userSet); *c != other {
		t.Fatal("rule overwrote a user categorization")
	}
	if category(t, pool, small) != nil {
		t.Fatal("amount condition ignored")
	}
	ta, _ := ledger.Get(context.Background(), pool, profile, a, false)
	if ta.CategorizationSource != "rule" {
		t.Fatalf("source %s", ta.CategorizationSource)
	}
	api.Must(http.StatusOK, "GET", "/rules/"+rule.ID.String(), nil, &rule)
	if rule.MatchCount != 2 || rule.LastMatchedAt == nil {
		t.Fatalf("stats: %+v", rule)
	}

	// Undo restores both; a transaction edited in between is left alone.
	_, _ = pool.Exec(context.Background(), `UPDATE transactions SET version = version + 1 WHERE id = $1`, b)
	var undo struct {
		Updated int
		Failed  []struct{ ID uuid.UUID }
	}
	api.Must(http.StatusOK, "POST", "/rules/applications/"+res.ApplicationID.String()+"/undo", nil, &undo)
	if undo.Updated != 1 || len(undo.Failed) != 1 || undo.Failed[0].ID != b || category(t, pool, a) != nil {
		t.Fatalf("undo: %+v", undo)
	}

	// Automatic application to new transactions (used by imports / transaction creation).
	c := fintest.Txn(t, pool, profile, "expense", "2026-10-05", acc, "-30.00", "BAM", nil, "KONZUM 9")
	var changed []uuid.UUID
	err := pgx.BeginFunc(fintest.Ctx(user), pool, func(tx pgx.Tx) error {
		var err error
		changed, err = ApplyRules(fintest.Ctx(user), tx, profile, []uuid.UUID{c, userSet})
		return err
	})
	if err != nil || len(changed) != 1 || *category(t, pool, c) != groceries {
		t.Fatalf("auto apply: %v %v", changed, err)
	}

	// Server write paths (REST/MCP create) run the rules without a manual apply.
	amt := money.MustParse("12.00", "BAM")
	var created *ledger.Transaction
	err = pgx.BeginFunc(fintest.Ctx(user), pool, func(tx pgx.Tx) error {
		var err error
		created, err = transactions.Create(fintest.Ctx(user), tx, profile, transactions.Input{Kind: "expense", AccountID: acc,
			Amount: &amt, BookingDate: "2026-10-06", Description: "Konzum express"}, "manual")
		return err
	})
	if err != nil || created.CategorizationSource != "rule" || *category(t, pool, created.ID) != groceries {
		t.Fatalf("create did not run rules: %v %+v", err, created)
	}
}

func TestSuggestionsDuplicatesRecurring(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register)
	acc := fintest.Account(t, pool, profile, "Checking", "checking", "BAM")
	food := fintest.Category(t, pool, profile, "Restaurants", nil)
	for i := 1; i <= 3; i++ {
		id := fintest.Txn(t, pool, profile, "expense", fmt.Sprintf("2026-09-0%d", i), acc, "-12.00", "BAM", &food, fmt.Sprintf("PIZZA HUT %d", 100+i))
		_, _ = pool.Exec(context.Background(), `UPDATE transactions SET categorization_source = 'user' WHERE id = $1`, id)
	}
	fresh := fintest.Txn(t, pool, profile, "expense", "2026-10-10", acc, "-14.00", "BAM", nil, "Pizza Hut 999")
	var sugg struct{ Items []Suggestion }
	api.Must(http.StatusOK, "GET", "/suggestions?transactionId="+fresh.String(), nil, &sugg)
	if len(sugg.Items) != 1 || sugg.Items[0].Value != food.String() || sugg.Items[0].Confidence != "1.00" {
		t.Fatalf("suggestions: %+v", sugg.Items)
	}
	api.Must(http.StatusOK, "GET", "/suggestions", nil, &sugg)
	if len(sugg.Items) != 1 || sugg.Items[0].TransactionID != fresh {
		t.Fatalf("inbox suggestions: %+v", sugg.Items)
	}

	d1 := fintest.Txn(t, pool, profile, "expense", "2026-10-11", acc, "-55.40", "BAM", nil, "Shell 0042")
	d2 := fintest.Txn(t, pool, profile, "expense", "2026-10-11", acc, "-55.40", "BAM", nil, "SHELL 0042")
	fintest.Txn(t, pool, profile, "expense", "2026-10-20", acc, "-55.40", "BAM", nil, "Shell 0042") // too far apart
	var dups struct{ Items []DuplicateGroup }
	api.Must(http.StatusOK, "GET", "/duplicates?from=2026-10-01&to=2026-10-31", nil, &dups)
	if len(dups.Items) != 1 || dups.Items[0].Score != "0.90" || dups.Items[0].TransactionIDs[0] != d1 && dups.Items[0].TransactionIDs[0] != d2 {
		t.Fatalf("duplicates: %+v", dups.Items)
	}

	for _, d := range []string{"2026-06-05", "2026-07-05", "2026-08-06", "2026-09-05", "2026-10-05"} {
		fintest.Txn(t, pool, profile, "expense", d, acc, "-15.99", "BAM", nil, "NETFLIX.COM")
	}
	var rec struct{ Items []RecurringCandidate }
	api.Must(http.StatusOK, "GET", "/recurring-candidates", nil, &rec)
	var found *RecurringCandidate
	for i := range rec.Items {
		if rec.Items[i].Description == "NETFLIX.COM" {
			found = &rec.Items[i]
		}
	}
	if found == nil || found.Cadence != "monthly" || found.RRule != "FREQ=MONTHLY;BYMONTHDAY=5" || found.Amount.Amount() != "15.99" ||
		found.NextDate != "2026-11-05" || len(found.TransactionIDs) != 5 || found.Confidence != "1.00" {
		t.Fatalf("recurring: %+v", rec.Items)
	}
}
