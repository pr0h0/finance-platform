package categories_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/categories"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

// Server-made plaintext categories in an end-to-end encrypted profile would stall its clients'
// sync (they only accept envelopes), so seeding is refused there and works elsewhere.
func TestSeedDefaultsRefusesE2EEProfiles(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	_, plain := testdb.SeedUserProfile(t, pool)
	_, enc := testdb.SeedUserProfile(t, pool)
	if _, err := pool.Exec(ctx, `UPDATE profiles SET privacy_mode = 'e2ee' WHERE id = $1`, enc); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := ledger.InTx(ctx, pool, func(tx pgx.Tx) (err error) { n, err = categories.SeedDefaults(ctx, tx, plain); return }); err != nil || n == 0 {
		t.Fatalf("server-readable profile: created %d, err %v", n, err)
	}
	err := ledger.InTx(ctx, pool, func(tx pgx.Tx) (err error) { n, err = categories.SeedDefaults(ctx, tx, enc); return })
	var he *httpx.Error
	if !errors.As(err, &he) || he.Code != "e2ee_profile" {
		t.Fatalf("e2ee profile: want e2ee_profile error, got %d, %v", n, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM categories WHERE profile_id = $1`, enc).Scan(&n); err != nil || n != 0 {
		t.Fatalf("e2ee profile has %d plaintext categories (%v)", n, err)
	}
}
