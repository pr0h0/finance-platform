package profiles_test

import (
	"net/http"
	"testing"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin/fintest"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/profiles"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

// Devices sync single setting keys with PATCH (merge, null removes); server features read the same
// object (fin.Setting), e.g. forecast.minimumReserve for safe-to-spend.
func TestPatchSettingsMerges(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, profiles.Register)
	base := "/profiles/" + profile.String() + "/settings"
	var got map[string]any
	api.Must(http.StatusOK, "PATCH", base, map[string]any{"forecast.minimumReserve": map[string]string{"amount": "300.00", "currency": "BAM"}, "a": 1}, &got)
	got = nil // Unmarshal into a map keeps old keys
	api.Must(http.StatusOK, "PATCH", base, map[string]any{"b": []string{"x"}, "a": nil}, &got)
	if _, ok := got["a"]; ok || got["b"] == nil || got["forecast.minimumReserve"] == nil {
		t.Fatalf("merged: %v", got)
	}
	got = nil
	api.Must(http.StatusOK, "GET", base, nil, &got)
	if len(got) != 2 {
		t.Fatalf("stored: %v", got)
	}
	var reserve money.Money
	ok, err := fin.Setting(fintest.Ctx(user), pool, profile, "forecast.minimumReserve", &reserve)
	if err != nil || !ok || reserve.Amount() != "300.00" {
		t.Fatalf("fin.Setting: %v %v %s", ok, err, reserve.Amount())
	}
	if ok, err := fin.Setting(fintest.Ctx(user), pool, profile, "missing", &reserve); ok || err != nil {
		t.Fatalf("missing key: %v %v", ok, err)
	}
}
