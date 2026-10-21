package imports

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// Querier is satisfied by *pgxpool.Pool and pgx.Tx.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Money reads a NUMERIC rendered as text (amount::text) into Money.
func Money(text, currency string) (money.Money, error) {
	return money.Parse(trimZeros(text), strings.TrimSpace(currency))
}

// trimZeros drops insignificant fraction zeros of a NUMERIC(30,10) text ("150.0000000000" -> "150").
func trimZeros(s string) string {
	if !strings.Contains(s, ".") {
		return s
	}
	s = strings.TrimRight(s, "0")
	return strings.TrimSuffix(s, ".")
}

func dateStr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format(time.DateOnly)
	return &s
}
