package notifications_test

import (
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/server"
)

// The full server must build with every planning/analytics route registered exactly once
// (chi panics on conflicting wildcards; a duplicate path would silently shadow another module).
func TestServerRegistersPlanningAnalyticsRoutes(t *testing.T) {
	h := server.New(&app.Deps{Config: &config.Config{}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	seen := map[string]int{}
	err := chi.Walk(h.(chi.Routes), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		seen[method+" "+strings.TrimSuffix(route, "/")]++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range []string{
		"GET /api/v1/plans/occurrences", "PUT /api/v1/plans/{id}/occurrences/{date}", "GET /api/v1/bill-calendar",
		"GET /api/v1/budgets/{id}/status", "POST /api/v1/budgets/{id}/periods/close", "GET /api/v1/goals/emergency-fund",
		"GET /api/v1/forecasts/cash-flow", "POST /api/v1/forecasts/scenarios", "GET /api/v1/analytics/net-worth",
		"POST /api/v1/analytics/anomalies/{transactionId}/dismiss", "GET /api/v1/reports/{kind}", "POST /api/v1/rules/{id}/apply",
		"POST /api/v1/rules/applications/{applicationId}/undo", "GET /api/v1/recurring-candidates", "GET /api/v1/notifications",
		"POST /api/v1/recurrences/preview",
	} {
		if seen[r] != 1 {
			t.Errorf("%s registered %d times", r, seen[r])
		}
	}
}
