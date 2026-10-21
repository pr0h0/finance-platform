// Package fin holds the read-side building blocks shared by the planning, budgets, savings,
// forecasting, analytics, automation and notifications modules: calendar dates, profile context,
// historical FX valuation and ledger aggregation queries. It never writes.
//
// Valuation policy (docs/architecture/valuation-policy.md):
//   - An amount in currency C on local date D is valued in reporting currency R with the most recent
//     rate dated on or before D: a profile manual override beats the fixed EUR/BAM rate, which beats
//     provider rates (by provider priority); direct quotes and inverse quotes are both used.
//   - If no direct/inverse rate exists the conversion triangulates through EUR.
//   - The product is rounded once, half-up, to R's minor units.
//   - No rate on or before D: the amount is left out of the total, the pair/date is reported in
//     MissingRates and the result is marked incomplete. Nothing is guessed.
package fin

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// DB is satisfied by *pgxpool.Pool and pgx.Tx.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// ===== calendar dates (time.Time at UTC midnight; never shifted by a timezone) =====

const DateLayout = "2006-01-02"

// Now is the clock; tests replace it.
var Now = time.Now

func Date(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

func ParseDate(s string) (time.Time, error) {
	t, err := time.Parse(DateLayout, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid date %q (want YYYY-MM-DD)", s)
	}
	return t, nil
}

func MustDate(s string) time.Time {
	t, err := ParseDate(s)
	if err != nil {
		panic(err)
	}
	return t
}

func Fmt(t time.Time) string { return t.Format(DateLayout) }

// FmtPtr formats an optional date.
func FmtPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := Fmt(*t)
	return &s
}

// AsDate normalizes a scanned date to UTC midnight.
func AsDate(t time.Time) time.Time { return Date(t.Year(), t.Month(), t.Day()) }

func DaysIn(y int, m time.Month) int   { return Date(y, m+1, 0).Day() }
func MonthStart(t time.Time) time.Time { return Date(t.Year(), t.Month(), 1) }
func MonthEnd(t time.Time) time.Time   { return Date(t.Year(), t.Month()+1, 0) }

// AddMonthsClamped adds n months keeping the day, clamped to the target month's last day.
func AddMonthsClamped(t time.Time, n int, day int) time.Time {
	first := Date(t.Year(), t.Month()+time.Month(n), 1)
	return Date(first.Year(), first.Month(), min(day, DaysIn(first.Year(), first.Month())))
}

// DaysBetween is b - a in whole days.
func DaysBetween(a, b time.Time) int { return int(b.Sub(a).Hours() / 24) }

// TodayIn is the local calendar date in the IANA zone (UTC on unknown zones).
func TodayIn(tz string) time.Time {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	n := Now().In(loc)
	return Date(n.Year(), n.Month(), n.Day())
}

// ===== profile context =====

type Profile struct {
	ID           uuid.UUID
	BaseCurrency string
	Timezone     string
	Today        time.Time // local date in the profile timezone
}

func LoadProfile(ctx context.Context, q DB, id uuid.UUID) (Profile, error) {
	p := Profile{ID: id}
	err := q.QueryRow(ctx, `SELECT base_currency, timezone FROM profiles WHERE id = $1 AND deleted_at IS NULL`, id).
		Scan(&p.BaseCurrency, &p.Timezone)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, httpx.NotFound("profile")
	}
	if err != nil {
		return p, fmt.Errorf("load profile: %w", err)
	}
	p.BaseCurrency = strings.TrimSpace(p.BaseCurrency)
	p.Today = TodayIn(p.Timezone)
	return p, nil
}

// ===== query parameters =====

// QueryDate reads an optional YYYY-MM-DD query parameter.
func QueryDate(r *http.Request, name string, def time.Time) (time.Time, error) {
	s := r.URL.Query().Get(name)
	if s == "" {
		return def, nil
	}
	t, err := ParseDate(s)
	if err != nil {
		return t, httpx.Validation(map[string]string{name: err.Error()})
	}
	return t, nil
}

// Range reads from/to (inclusive) with defaults; rejects inverted or over-long (> maxDays) ranges.
func Range(r *http.Request, defFrom, defTo time.Time, maxDays int) (time.Time, time.Time, error) {
	from, err := QueryDate(r, "from", defFrom)
	if err != nil {
		return from, from, err
	}
	to, err := QueryDate(r, "to", defTo)
	if err != nil {
		return from, to, err
	}
	if to.Before(from) {
		return from, to, httpx.Validation(map[string]string{"to": "must not be before from"})
	}
	if maxDays > 0 && DaysBetween(from, to) > maxDays {
		return from, to, httpx.Validation(map[string]string{"to": fmt.Sprintf("range is limited to %d days", maxDays)})
	}
	return from, to, nil
}

// Currency reads ?currency= (default: profile base currency) and checks it is known.
func Currency(r *http.Request, p Profile) (string, error) {
	c := strings.ToUpper(r.URL.Query().Get("currency"))
	if c == "" {
		c = p.BaseCurrency
	}
	if _, ok := money.Scale(c); !ok {
		return "", httpx.Validation(map[string]string{"currency": "unknown currency"})
	}
	return c, nil
}

// AccountIDs reads repeated ?accountId= parameters (nil = all).
func AccountIDs(r *http.Request) ([]uuid.UUID, error) {
	var out []uuid.UUID
	for _, v := range r.URL.Query()["accountId"] {
		for _, s := range strings.Split(v, ",") {
			id, err := uuid.Parse(strings.TrimSpace(s))
			if err != nil {
				return nil, httpx.Validation(map[string]string{"accountId": "must be a uuid"})
			}
			out = append(out, id)
		}
	}
	return out, nil
}

// ===== money helpers =====

func Zero(cur string) money.Money {
	z, err := money.Zero(cur)
	if err != nil {
		panic(err)
	}
	return z
}

// MulRat returns m * num / den rounded once (half up) to m's scale.
func MulRat(m money.Money, num, den int64) money.Money {
	n := new(big.Int).Mul(m.Minor(), big.NewInt(num))
	out, _ := money.FromMinor(money.DivRound(n, big.NewInt(den), money.HalfUp), m.Currency())
	return out
}

// Ratio formats a/b as a decimal string with `scale` fraction digits (half up); "" if b is zero.
func Ratio(a, b money.Money, scale int) string {
	if b.IsZero() || a.Currency() != b.Currency() {
		return ""
	}
	num := new(big.Int).Mul(a.Minor(), new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil))
	return formatScaled(money.DivRound(num, b.Minor(), money.HalfUp), scale)
}

func formatScaled(u *big.Int, scale int) string {
	neg := u.Sign() < 0
	s := new(big.Int).Abs(u).String()
	for len(s) <= scale {
		s = "0" + s
	}
	if scale > 0 {
		s = s[:len(s)-scale] + "." + s[len(s)-scale:]
	}
	if neg {
		s = "-" + s
	}
	return s
}

// NumericMoney scans helper: numeric + currency -> Money.
func NumericMoney(n pgtype.Numeric, cur string) (money.Money, error) {
	return money.FromNumeric(n, strings.TrimSpace(cur))
}

// OptMoney converts a nullable numeric.
func OptMoney(n pgtype.Numeric, cur string) (*money.Money, error) {
	if !n.Valid {
		return nil, nil
	}
	m, err := NumericMoney(n, cur)
	return &m, err
}

// ===== FX valuation =====

type MissingRate struct {
	From string `json:"from"`
	To   string `json:"to"`
	Date string `json:"date"`
}

type ratePoint struct {
	date time.Time
	rate *big.Rat // units of quote per 1 base
}

// Converter values amounts in another currency with historical rates (see package doc). Not safe
// for concurrent use; create one per request.
type Converter struct {
	db        DB
	profileID uuid.UUID
	pairs     map[[2]string][]ratePoint
	missing   map[MissingRate]bool
}

func NewConverter(db DB, profileID uuid.UUID) *Converter {
	return &Converter{db: db, profileID: profileID, pairs: map[[2]string][]ratePoint{}, missing: map[MissingRate]bool{}}
}

func (c *Converter) load(ctx context.Context, base, quote string) ([]ratePoint, error) {
	k := [2]string{base, quote}
	if pts, ok := c.pairs[k]; ok {
		return pts, nil
	}
	// Per date the last row wins: provider (by ascending priority value = higher precedence last)
	// < fixed < profile override.
	rows, err := c.db.Query(ctx, `SELECT r.rate::text, r.rate_date FROM exchange_rates r
		LEFT JOIN exchange_rate_providers pr ON pr.id = r.provider_id
		WHERE r.base_currency = $1 AND r.quote_currency = $2 AND (r.profile_id IS NULL OR r.profile_id = $3)
		ORDER BY r.rate_date, (r.profile_id IS NOT NULL), (r.source = 'fixed'), coalesce(pr.priority, 1000) DESC, r.fetched_at`,
		base, quote, c.profileID)
	if err != nil {
		return nil, fmt.Errorf("load rates: %w", err)
	}
	defer rows.Close()
	var pts []ratePoint
	for rows.Next() {
		var s string
		var d time.Time
		if err := rows.Scan(&s, &d); err != nil {
			return nil, err
		}
		r, ok := new(big.Rat).SetString(s)
		if !ok || r.Sign() <= 0 {
			continue
		}
		d = AsDate(d)
		if n := len(pts); n > 0 && pts[n-1].date.Equal(d) {
			pts[n-1].rate = r
		} else {
			pts = append(pts, ratePoint{d, r})
		}
	}
	c.pairs[k] = pts
	return pts, rows.Err()
}

func latest(pts []ratePoint, on time.Time) (ratePoint, bool) {
	i := sort.Search(len(pts), func(i int) bool { return pts[i].date.After(on) })
	if i == 0 {
		return ratePoint{}, false
	}
	return pts[i-1], true
}

// rate returns units of `to` per 1 `from` valid on `on`.
func (c *Converter) rate(ctx context.Context, from, to string, on time.Time) (*big.Rat, bool, error) {
	direct, err := c.load(ctx, from, to)
	if err != nil {
		return nil, false, err
	}
	inverse, err := c.load(ctx, to, from)
	if err != nil {
		return nil, false, err
	}
	d, okD := latest(direct, on)
	i, okI := latest(inverse, on)
	switch {
	case okD && (!okI || !i.date.After(d.date)):
		return d.rate, true, nil
	case okI:
		return new(big.Rat).Inv(i.rate), true, nil
	}
	return nil, false, nil
}

// Rate is the exact conversion factor from -> to on a date (via EUR when needed).
func (c *Converter) Rate(ctx context.Context, from, to string, on time.Time) (*big.Rat, bool, error) {
	if from == to {
		return big.NewRat(1, 1), true, nil
	}
	r, ok, err := c.rate(ctx, from, to, on)
	if err != nil || ok {
		return r, ok, err
	}
	if from != "EUR" && to != "EUR" {
		a, okA, err := c.rate(ctx, from, "EUR", on)
		if err != nil {
			return nil, false, err
		}
		b, okB, err := c.rate(ctx, "EUR", to, on)
		if err != nil {
			return nil, false, err
		}
		if okA && okB {
			return new(big.Rat).Mul(a, b), true, nil
		}
	}
	return nil, false, nil
}

// Convert values m in `to` on date `on`. ok=false (and a recorded MissingRate) when no rate exists.
func (c *Converter) Convert(ctx context.Context, m money.Money, to string, on time.Time) (money.Money, bool, error) {
	if m.Currency() == to {
		return m, true, nil
	}
	r, ok, err := c.Rate(ctx, m.Currency(), to, on)
	if err != nil {
		return money.Money{}, false, err
	}
	if !ok {
		c.missing[MissingRate{From: m.Currency(), To: to, Date: Fmt(on)}] = true
		return Zero(to), false, nil
	}
	return ConvertRat(m, to, r), true, nil
}

// ConvertRat converts with an exact rate, rounding once half-up.
func ConvertRat(m money.Money, to string, r *big.Rat) money.Money {
	fs, _ := money.Scale(m.Currency())
	ts, _ := money.Scale(to)
	num := new(big.Int).Mul(m.Minor(), r.Num())
	num.Mul(num, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(ts)), nil))
	den := new(big.Int).Mul(r.Denom(), new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(fs)), nil))
	out, _ := money.FromMinor(money.DivRound(num, den, money.HalfUp), to)
	return out
}

// Missing lists the pairs/dates that could not be valued (sorted, deduplicated).
func (c *Converter) Missing() []MissingRate {
	out := make([]MissingRate, 0, len(c.missing))
	for k := range c.missing {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date < out[j].Date
		}
		return out[i].From+out[i].To < out[j].From+out[j].To
	})
	return out
}

// Complete is true when every conversion so far found a rate.
func (c *Converter) Complete() bool { return len(c.missing) == 0 }

// Accumulator sums amounts in one reporting currency.
type Accumulator struct{ units *big.Int }

func (a *Accumulator) Add(m money.Money) {
	if a.units == nil {
		a.units = new(big.Int)
	}
	a.units.Add(a.units, m.Minor())
}

func (a *Accumulator) Sub(m money.Money) { a.Add(m.Neg()) }

func (a *Accumulator) Money(cur string) money.Money {
	if a.units == nil {
		return Zero(cur)
	}
	m, _ := money.FromMinor(a.units, cur)
	return m
}
