package authz_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

func TestRequireProfile(t *testing.T) {
	pool := testdb.New(t)
	u1, p1 := testdb.SeedUserProfile(t, pool)
	u2, _ := testdb.SeedUserProfile(t, pool)
	ctx1 := authz.WithPrincipal(context.Background(), authz.Principal{UserID: u1, ActorType: authz.ActorUser})
	ctx2 := authz.WithPrincipal(context.Background(), authz.Principal{UserID: u2, ActorType: authz.ActorUser})

	if _, role, err := authz.RequireProfile(ctx1, pool, p1, authz.RoleOwner); err != nil || role != authz.RoleOwner {
		t.Fatalf("owner denied: %v", err)
	}
	if _, _, err := authz.RequireProfile(ctx2, pool, p1, authz.RoleViewer); !errors.Is(err, authz.ErrForbidden) {
		t.Fatalf("other user allowed: %v", err)
	}
	if _, _, err := authz.RequireProfile(context.Background(), pool, p1, authz.RoleViewer); !errors.Is(err, authz.ErrUnauthenticated) {
		t.Fatalf("anonymous allowed: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO profile_members VALUES ($1,$2,'viewer')`, p1, u2); err != nil {
		t.Fatal(err)
	}
	if _, _, err := authz.RequireProfile(ctx2, pool, p1, authz.RoleEditor); !errors.Is(err, authz.ErrForbidden) {
		t.Fatalf("viewer got editor: %v", err)
	}
	if _, _, err := authz.RequireProfile(ctx2, pool, uuid.New(), authz.RoleViewer); !errors.Is(err, authz.ErrForbidden) {
		t.Fatalf("unknown profile: %v", err)
	}
}
