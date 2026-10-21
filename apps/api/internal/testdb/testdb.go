// Package testdb gives each test package its own freshly migrated PostgreSQL database.
// Set TEST_DATABASE_URL (e.g. postgres://finplat:finplat@postgres:5432/finplat?sslmode=disable);
// tests needing a DB are skipped when it is unset.
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"net/url"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/database"
)

// New creates database finplat_test_<random>, migrates it and drops it on cleanup.
func New(t testing.TB) *pgxpool.Pool {
	t.Helper()
	base := os.Getenv("TEST_DATABASE_URL")
	if base == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatalf("testdb: connect: %v", err)
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "finplat_test_" + hex.EncodeToString(b)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("testdb: create: %v", err)
	}
	u, _ := url.Parse(base)
	u.Path = "/" + name
	pool, err := database.Open(ctx, u.String(), 5)
	if err != nil {
		t.Fatalf("testdb: open: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		admin.Close(ctx)
	})
	if err := database.Migrate(ctx, pool, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatalf("testdb: migrate: %v", err)
	}
	return pool
}

// SeedUserProfile inserts a user and a profile they own (role owner). Returns their ids.
func SeedUserProfile(t testing.TB, pool *pgxpool.Pool) (userID, profileID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	userID, profileID = uuid.New(), uuid.New()
	_, err := pool.Exec(ctx, `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Test')`, userID, userID.String()+"@test.local")
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO profiles (id, name, owner_user_id) VALUES ($1, 'Personal', $2)`, profileID, userID)
	}
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO profile_members (profile_id, user_id, role) VALUES ($1, $2, 'owner')`, profileID, userID)
	}
	if err != nil {
		t.Fatalf("testdb: seed: %v", err)
	}
	return userID, profileID
}
