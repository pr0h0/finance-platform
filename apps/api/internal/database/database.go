// Package database opens the pgx pool and runs embedded goose migrations.
package database

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/pr0h0/finance-platform/apps/api/migrations"
)

func Open(ctx context.Context, url string, maxConns int32) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = maxConns
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

func provider(pool *pgxpool.Pool) (*goose.Provider, *sql.DB, error) {
	db := stdlib.OpenDBFromPool(pool)
	// Out-of-order allowed: parallel branches add timestamped migrations independently.
	p, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS, goose.WithAllowOutofOrder(true))
	if err != nil {
		db.Close()
		return nil, nil, err
	}
	return p, db, nil
}

// Migrate applies all pending migrations.
func Migrate(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	p, db, err := provider(pool)
	if err != nil {
		return err
	}
	defer db.Close()
	res, err := p.Up(ctx)
	for _, r := range res {
		log.Info("migration applied", "version", r.Source.Version, "file", r.Source.Path, "duration", r.Duration)
	}
	return err
}

// Status prints migration state lines.
func Status(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	p, db, err := provider(pool)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	st, err := p.Status(ctx)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, s := range st {
		out = append(out, fmt.Sprintf("%-8s %s", s.State, s.Source.Path))
	}
	return out, nil
}

// SchemaVersion is the highest applied migration version (exposed via /api/v1/meta).
func SchemaVersion(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	var v int64
	err := pool.QueryRow(ctx, `SELECT COALESCE(MAX(version_id), 0) FROM goose_db_version WHERE is_applied`).Scan(&v)
	return v, err
}
