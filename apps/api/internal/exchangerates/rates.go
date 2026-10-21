package exchangerates

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// ErrNoRate means no snapshot exists for the pair on or before the date (directly, inverted or via EUR).
var ErrNoRate = errors.New("exchangerates: no rate available")

// Rate is the rate used to convert From -> To on a date.
//
// Valuation policy (PLAN feature 19, documented in docs/architecture/financial-invariants.md):
// the snapshot with the latest rate_date on or before the requested date wins; legally fixed rates
// (EUR/BAM 1.95583) are always current; on the same date a profile's manual override beats the
// fixed rate, which beats provider rates (by provider priority, then latest fetch).
type Rate struct {
	ID       *uuid.UUID `json:"id"` // snapshot used; nil for a cross rate
	From     string     `json:"from"`
	To       string     `json:"to"`
	Stored   string     `json:"-"`        // stored quote (1 base = Stored quote)
	Inverse  bool       `json:"inverse"`  // the snapshot is To->From, conversion divides by Stored
	RateDate string     `json:"rateDate"` // effective date of the snapshot (oldest leg for cross rates)
	Source   string     `json:"source"`   // provider | manual | fixed
}

// Value is the effective rate (To per 1 From) as a decimal string with at most 18 fraction digits.
func (r Rate) Value() string {
	if !r.Inverse {
		return ledger.TrimDecimal(r.Stored)
	}
	q, _ := new(big.Rat).SetString(r.Stored)
	return ledger.TrimDecimal(new(big.Rat).Inv(q).FloatString(18))
}

// Convert applies the rate once, rounding to the target currency scale with mode.
func (r Rate) Convert(m money.Money, mode money.RoundingMode) (money.Money, error) {
	if m.Currency() != r.From {
		return money.Money{}, money.ErrCurrencyMismatch
	}
	if r.Inverse {
		return m.ConvertInverse(r.To, r.Stored, mode)
	}
	return m.Convert(r.To, r.Stored, mode)
}

// Lookup finds the rate From -> To for date (YYYY-MM-DD) visible to profileID (global + its manual
// overrides). Same currency returns rate 1. Falls back to the inverse pair and then a cross via EUR.
func Lookup(ctx context.Context, db ledger.DB, profileID uuid.UUID, from, to, date string) (Rate, error) {
	if from == to {
		return Rate{From: from, To: to, Stored: "1", RateDate: date, Source: "fixed"}, nil
	}
	r, err := lookupPair(ctx, db, profileID, from, to, date)
	if !errors.Is(err, ErrNoRate) || from == "EUR" || to == "EUR" {
		return r, err
	}
	a, err := lookupPair(ctx, db, profileID, from, "EUR", date)
	if err != nil {
		return Rate{}, err
	}
	b, err := lookupPair(ctx, db, profileID, "EUR", to, date)
	if err != nil {
		return Rate{}, err
	}
	// ponytail: the cross rate is rounded once to 18 fraction digits (rate precision of NUMERIC(38,18)).
	av, _ := new(big.Rat).SetString(a.Value())
	bv, _ := new(big.Rat).SetString(b.Value())
	cross := Rate{From: from, To: to, Stored: ledger.TrimDecimal(new(big.Rat).Mul(av, bv).FloatString(18)),
		RateDate: min(a.RateDate, b.RateDate), Source: weakest(a.Source, b.Source)}
	return cross, nil
}

// weakest names the least authoritative leg of a cross rate: fixed < manual < provider.
func weakest(a, b string) string {
	rank := map[string]int{"fixed": 0, "manual": 1, "provider": 2}
	if rank[a] >= rank[b] {
		return a
	}
	return b
}

func lookupPair(ctx context.Context, db ledger.DB, profileID uuid.UUID, from, to, date string) (Rate, error) {
	var r Rate
	var base string
	err := db.QueryRow(ctx, `SELECT er.id, er.base_currency, er.rate::text, er.rate_date::text, er.source
		FROM exchange_rates er LEFT JOIN exchange_rate_providers p ON p.id = er.provider_id
		WHERE ((er.base_currency = $2 AND er.quote_currency = $3) OR (er.base_currency = $3 AND er.quote_currency = $2))
		  AND (er.profile_id IS NULL OR er.profile_id = $1) AND er.rate_date <= $4::date
		  AND (p.id IS NULL OR p.enabled)
		ORDER BY CASE WHEN er.source = 'fixed' THEN $4::date ELSE er.rate_date END DESC,
		  CASE er.source WHEN 'manual' THEN 0 WHEN 'fixed' THEN 1 ELSE 2 END,
		  (er.base_currency = $2) DESC, p.priority NULLS LAST, er.fetched_at DESC
		LIMIT 1`, profileID, from, to, date).Scan(&r.ID, &base, &r.Stored, &r.RateDate, &r.Source)
	if errors.Is(err, pgx.ErrNoRows) {
		return Rate{}, fmt.Errorf("%w for %s/%s on %s", ErrNoRate, from, to, date)
	}
	if err != nil {
		return Rate{}, fmt.Errorf("lookup rate: %w", err)
	}
	r.From, r.To, r.Inverse = from, to, base != from
	r.Stored = ledger.TrimDecimal(r.Stored)
	if r.Source == "fixed" {
		r.RateDate = date
	}
	return r, nil
}

func init() {
	// Net worth / balance valuation uses cached snapshots only (no network on the read path).
	ledger.DefaultConverter = func(ctx context.Context, db ledger.DB, profileID uuid.UUID, m money.Money, to, date string) (money.Money, bool, error) {
		r, err := Lookup(ctx, db, profileID, m.Currency(), to, date)
		if errors.Is(err, ErrNoRate) {
			return money.Money{}, false, nil
		}
		if err != nil {
			return money.Money{}, false, err
		}
		c, err := r.Convert(m, money.DefaultRounding)
		return c, err == nil, err
	}
}

// ValidRate checks a positive decimal rate string with at most 18 fraction digits.
func ValidRate(s string) error {
	r, ok := new(big.Rat).SetString(s)
	if !ok || r.Sign() <= 0 || strings.ContainsAny(s, "eE/") || strings.HasPrefix(s, "+") {
		return errors.New("must be a positive decimal string")
	}
	if i := strings.IndexByte(s, '.'); i >= 0 && len(s)-i-1 > 18 {
		return errors.New("at most 18 fraction digits")
	}
	if len(strings.SplitN(s, ".", 2)[0]) > 20 {
		return errors.New("too large")
	}
	return nil
}
