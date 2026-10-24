package notifications

import (
	"encoding/json"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"net/http"
	"testing"
	"time"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin/fintest"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

func init() {
	fin.Now = func() time.Time { return time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC) }
}

func TestGenerateAndManage(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register, planning.Register)
	acc := fintest.Account(t, pool, profile, "Checking", "checking", "BAM")
	fintest.Txn(t, pool, profile, "opening_balance", "2026-10-01", acc, "100.00", "BAM", nil, "open")
	plan := func(desc, due string, reminder *int) {
		api.Must(http.StatusCreated, "POST", "/plans", map[string]any{"kind": "expense", "accountId": acc, "description": desc,
			"amount": map[string]string{"amount": "300.00", "currency": "BAM"}, "dueDate": due, "reminderDaysBefore": reminder}, nil)
	}
	five := 5
	plan("Rent", "2026-10-17", nil)        // due in 2 days: reminder (default 3 days)
	plan("Insurance", "2026-10-19", &five) // due in 4 days, reminder 5 days before
	plan("Car tax", "2026-10-30", nil)     // not yet
	plan("Phone", "2026-10-12", nil)       // overdue

	ctx := fintest.Ctx(user)
	n, err := Generate(ctx, pool, profile)
	if err != nil {
		t.Fatal(err)
	}
	// rent, insurance, phone overdue, low balance (100 - 300 on Oct 15 for the overdue phone).
	if n != 4 {
		t.Fatalf("generated %d", n)
	}
	if n, _ := Generate(ctx, pool, profile); n != 0 {
		t.Fatalf("second run must be deduplicated, got %d", n)
	}
	var list struct {
		Items []Notification
	}
	api.Must(http.StatusOK, "GET", "/notifications?unread=true", nil, &list)
	kinds := map[string]int{}
	for _, x := range list.Items {
		kinds[x.Kind]++
	}
	if len(list.Items) != 4 || kinds["bill_due"] != 2 || kinds["bill_overdue"] != 1 || kinds["low_balance"] != 1 {
		t.Fatalf("list: %+v", kinds)
	}
	api.Must(http.StatusNoContent, "POST", "/notifications/"+list.Items[0].ID.String()+"/read", nil, nil)
	api.Must(http.StatusOK, "GET", "/notifications?unread=true", nil, &list)
	if len(list.Items) != 3 {
		t.Fatalf("after read: %d", len(list.Items))
	}
	api.Must(http.StatusNoContent, "DELETE", "/notifications/"+list.Items[0].ID.String(), nil, nil)
	api.Must(http.StatusNoContent, "POST", "/notifications/read-all", nil, nil)
	api.Must(http.StatusOK, "GET", "/notifications", nil, &list)
	if len(list.Items) != 3 || list.Items[0].ReadAt == nil {
		t.Fatalf("after dismiss/read-all: %+v", list.Items)
	}
	// Another user cannot touch them.
	other, _ := testdb.SeedUserProfile(t, pool)
	otherAPI := fintest.NewAPI(t, pool, other, profile, Register)
	otherAPI.Must(http.StatusNotFound, "POST", "/notifications/"+list.Items[0].ID.String()+"/read", nil, nil)
}

// Server-generated text follows users.locale (bs) instead of always English.
func TestGenerateBosnian(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	if _, err := pool.Exec(t.Context(), `UPDATE users SET locale = 'bs' WHERE id = $1`, user); err != nil {
		t.Fatal(err)
	}
	api := fintest.NewAPI(t, pool, user, profile, Register, planning.Register)
	acc := fintest.Account(t, pool, profile, "Tekući", "checking", "BAM")
	fintest.Txn(t, pool, profile, "opening_balance", "2026-10-01", acc, "1000.00", "BAM", nil, "open")
	for _, p := range [][2]string{{"Kirija", "2026-10-16"}, {"Telefon", "2026-10-12"}} {
		api.Must(http.StatusCreated, "POST", "/plans", map[string]any{"kind": "expense", "accountId": acc, "description": p[0],
			"amount": map[string]string{"amount": "30.00", "currency": "BAM"}, "dueDate": p[1]}, nil)
	}
	if _, err := Generate(fintest.Ctx(user), pool, profile); err != nil {
		t.Fatal(err)
	}
	var list struct{ Items []Notification }
	api.Must(http.StatusOK, "GET", "/notifications", nil, &list)
	got := map[string]string{}
	for _, x := range list.Items {
		got[x.Title] = x.Body
	}
	if got["Kirija dospijeva sutra"] != "30,00 KM je zakazano za sutra." || got["Kasni: Telefon"] == "" {
		t.Fatalf("bs notifications: %+v", got)
	}
	// Code + params let the web render them in the UI language, whatever users.locale was.
	type params struct {
		Name, Date string
		Amount     struct{ Amount, Currency string }
	}
	codes := map[string]params{}
	for _, x := range list.Items {
		var p params
		if x.Code != nil && json.Unmarshal(x.Params, &p) == nil {
			codes[*x.Code] = p
		}
	}
	due, late := codes["bill_due_tomorrow"], codes["bill_overdue"]
	if due.Name != "Kirija" || due.Date != "2026-10-16" || due.Amount.Amount != "30.00" || due.Amount.Currency != "BAM" ||
		late.Name != "Telefon" || late.Date != "2026-10-12" {
		t.Fatalf("codes: %+v", codes)
	}
}

func TestPercent(t *testing.T) {
	for in, want := range map[string]string{"0.855": "86", "1": "100", "0.8": "80", "1.25": "125"} {
		if got := percent(in); got != want {
			t.Errorf("percent(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBosnianNumbers(t *testing.T) {
	for in, want := range map[string]string{"0.5": "0,5", "1234.56": "1.234,56", "-1234567.00": "-1.234.567,00", "999": "999"} {
		if got := bsDecimal(in); got != want {
			t.Errorf("bsDecimal(%q) = %q, want %q", in, got, want)
		}
	}
	if got := bsMoney(money.MustParse("1500.00", "BAM")); got != "1.500,00 KM" {
		t.Errorf("bsMoney = %q", got)
	}
	if got := bsMoney(money.MustParse("-20.50", "EUR")); got != "-20,50 EUR" {
		t.Errorf("bsMoney = %q", got)
	}
}
