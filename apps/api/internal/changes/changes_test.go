package changes_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

func TestRecordAllocatesMonotonicVersionsAndAudits(t *testing.T) {
	pool := testdb.New(t)
	userID, profileID := testdb.SeedUserProfile(t, pool)
	ctx := authz.WithPrincipal(context.Background(), authz.Principal{UserID: userID, ActorType: authz.ActorUser})

	tagID := uuid.New()
	var versions []int64
	for i, op := range []changes.Op{changes.OpUpsert, changes.OpUpsert, changes.OpDelete} {
		err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			if i == 0 {
				if _, err := tx.Exec(ctx, `INSERT INTO tags (id, profile_id, name) VALUES ($1,$2,'groceries')`, tagID, profileID); err != nil {
					return err
				}
			}
			v, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "tags", EntityID: tagID, Op: op,
				Data: map[string]any{"id": tagID, "name": "groceries"}, Action: "tag." + string(op)})
			versions = append(versions, v)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if versions[0] != 1 || versions[1] != 2 || versions[2] != 3 {
		t.Fatalf("versions not monotonic: %v", versions)
	}
	var sv int64
	_ = pool.QueryRow(ctx, `SELECT server_version FROM tags WHERE id=$1`, tagID).Scan(&sv)
	if sv != 3 {
		t.Fatalf("row server_version = %d", sv)
	}
	var n, audits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM sync_changes WHERE profile_id=$1`, profileID).Scan(&n)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE profile_id=$1 AND actor_id=$2`, profileID, userID).Scan(&audits)
	if n != 3 || audits != 3 {
		t.Fatalf("sync_changes=%d audits=%d", n, audits)
	}
}

func TestRecordRejectsForeignProfileRow(t *testing.T) {
	pool := testdb.New(t)
	_, p1 := testdb.SeedUserProfile(t, pool)
	_, p2 := testdb.SeedUserProfile(t, pool)
	ctx := context.Background()
	tagID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO tags (id, profile_id, name) VALUES ($1,$2,'x')`, tagID, p1); err != nil {
		t.Fatal(err)
	}
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		_, err := changes.Record(ctx, tx, changes.Change{ProfileID: p2, EntityType: "tags", EntityID: tagID, Op: changes.OpUpsert})
		return err
	})
	if err == nil {
		t.Fatal("expected error recording a row from another profile")
	}
}

func TestImmutabilityTriggers(t *testing.T) {
	pool := testdb.New(t)
	_, profileID := testdb.SeedUserProfile(t, pool)
	ctx := context.Background()
	var accID, txID uuid.UUID
	err := pool.QueryRow(ctx, `INSERT INTO accounts (profile_id, name, account_type, currency) VALUES ($1,'Main','checking','BAM') RETURNING id`, profileID).Scan(&accID)
	if err == nil {
		err = pool.QueryRow(ctx, `INSERT INTO transactions (profile_id, kind, booking_date) VALUES ($1,'expense','2026-01-31') RETURNING id`, profileID).Scan(&txID)
	}
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO postings (profile_id, transaction_id, account_id, amount, currency) VALUES ($1,$2,$3,-150.00,'BAM')`, profileID, txID, accID)
	}
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE postings SET amount = -10 WHERE transaction_id=$1`, txID); err == nil {
		t.Fatal("posting amount update must be rejected")
	}
	if _, err := pool.Exec(ctx, `UPDATE postings SET deleted_at = now() WHERE transaction_id=$1`, txID); err != nil {
		t.Fatalf("soft delete of posting must be allowed: %v", err)
	}
	var d string
	_ = pool.QueryRow(ctx, `SELECT booking_date::text FROM transactions WHERE id=$1`, txID).Scan(&d)
	if d != "2026-01-31" {
		t.Fatalf("date shifted: %s", d)
	}
}
