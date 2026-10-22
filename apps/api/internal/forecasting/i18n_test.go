package forecasting

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin/fintest"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

// Every warning format in engine.go/module.go, rendered with sample values.
func TestTranslateWarnings(t *testing.T) {
	for _, s := range []string{
		fmt.Sprintf("event %s on %s ignored: account not in forecast", "e1", "2026-10-01"),
		fmt.Sprintf("event %s on %s ignored: currency differs from account", "e1", "2026-10-01"),
		fmt.Sprintf("account %s (%s) left out: no %s/%s rate", "a1", "USD", "USD", "BAM"),
		fmt.Sprintf("reserve ignored: no %s/%s rate", "USD", "BAM"),
		fmt.Sprintf("plan %s has no account and is not forecast", "p1"),
		fmt.Sprintf("transfer plan %s has no destination account", "p1"),
		fmt.Sprintf("%d overdue planned item(s) are assumed to happen today; match or skip them to refine the forecast.", 3),
		"no accounts are included in this forecast",
	} {
		if bs, ok := translateBs(s); !ok || bs == s {
			t.Errorf("no Bosnian text for %q", s)
		}
	}
}

// Every assumption a real request produces has a Bosnian text, and ?lang=bs uses it.
func TestLocalizeBosnian(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register, planning.Register)
	acc := fintest.Account(t, pool, profile, "Checking", "checking", "BAM")
	fintest.Txn(t, pool, profile, "opening_balance", "2026-10-01", acc, "500.00", "BAM", nil, "Opening")

	body := map[string]any{"days": 30, "adjustments": []map[string]any{
		{"description": "Gift", "accountId": acc, "amount": map[string]string{"amount": "10.00", "currency": "BAM"}, "date": "2026-10-18"}}}
	var en, bs Forecast
	api.Must(http.StatusOK, "POST", "/forecasts/scenarios?lang=en", body, &en)
	api.Must(http.StatusOK, "POST", "/forecasts/scenarios?lang=bs", body, &bs)
	for _, s := range append(append([]string{}, en.Assumptions...), en.Warnings...) {
		if _, ok := translateBs(s); !ok {
			t.Errorf("no Bosnian text for %q", s)
		}
	}
	if len(bs.Assumptions) != len(en.Assumptions) {
		t.Fatalf("assumptions differ in count: %d vs %d", len(bs.Assumptions), len(en.Assumptions))
	}
	for i := range en.Assumptions {
		if bs.Assumptions[i] == en.Assumptions[i] {
			t.Errorf("assumption not localized: %q", en.Assumptions[i])
		}
	}
}

func TestLocalizeOverdueSuffix(t *testing.T) {
	f := Forecast{Warnings: []string{"no accounts are included in this forecast"},
		Days: []Day{{Events: []DayEvent{{Description: "Phone (overdue since 2026-10-10)"}}}}}
	Localize("bs", &f)
	if got := f.Days[0].Events[0].Description; got != "Phone (kasni od 10.10.2026.)" {
		t.Fatalf("event %q", got)
	}
	if f.Warnings[0] != "nijedan račun nije uključen u ovu prognozu" {
		t.Fatalf("warning %q", f.Warnings[0])
	}
}
