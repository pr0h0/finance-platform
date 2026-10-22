package exchangerates_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin/fintest"
	"github.com/pr0h0/finance-platform/apps/api/internal/exchangerates"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

// Sync clients upload manual rates with their own ids and fetch snapshots incrementally.
func TestRatesForSyncClients(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, exchangerates.Register)
	if _, err := pool.Exec(t.Context(), `INSERT INTO exchange_rates (base_currency, quote_currency, rate, rate_date, source, fetched_at)
		VALUES ('USD','BAM',1.8,'2026-10-01','provider', now() - interval '1 day')`); err != nil {
		t.Fatal(err)
	}
	before := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	id := uuid.New()
	var e exchangerates.ExchangeRate
	api.Must(http.StatusCreated, "POST", "/exchange-rates", map[string]any{"id": id, "baseCurrency": "USD", "quoteCurrency": "BAM", "rate": "1.70", "rateDate": "2026-10-20"}, &e)
	if e.ID != id || e.Source != "manual" {
		t.Fatalf("created %+v", e)
	}
	api.Must(http.StatusConflict, "POST", "/exchange-rates", map[string]any{"baseCurrency": "USD", "quoteCurrency": "BAM", "rate": "1.75", "rateDate": "2026-10-20"}, nil)

	var list struct{ Items []exchangerates.ExchangeRate }
	api.Must(http.StatusOK, "GET", "/exchange-rates?scope=profile", nil, &list)
	if len(list.Items) != 1 || list.Items[0].ID != id {
		t.Fatalf("scope=profile: %+v", list.Items)
	}
	api.Must(http.StatusOK, "GET", "/exchange-rates?base=USD&changedSince="+before, nil, &list)
	if len(list.Items) != 1 || list.Items[0].ID != id {
		t.Fatalf("changedSince: %+v", list.Items)
	}
	api.Must(http.StatusOK, "GET", "/exchange-rates?base=USD", nil, &list)
	if len(list.Items) != 2 {
		t.Fatalf("all: %+v", list.Items)
	}
	api.Must(http.StatusUnprocessableEntity, "GET", "/exchange-rates?changedSince=yesterday", nil, nil)
}
