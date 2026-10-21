// Package fin holds the read-side building blocks shared by the planning, budgets, savings,
// forecasting, analytics, automation and notifications modules: calendar dates, profile context,
// historical FX valuation and ledger aggregation queries. It never writes.
//
// Valuation policy (docs/architecture/valuation-policy.md):
//   - An amount in currency C on local date D is valued in reporting currency R with the rate
//     exchangerates.Lookup selects for D (historical rates, never today's rate for past flows).
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

	"github.com/pr0h0/finance-platform/apps/api/internal/exchangerates"
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

// Converter values amounts in another currency with historical rates. Rate selection is
// exchangerates.Lookup (the single valuation policy of the API: latest snapshot on or before the
// date, legally fixed EUR/BAM always current, manual override > fixed > provider, inverse pairs,
// cross via EUR); conversion rounds once, half-up. Lookups are cached per pair and date. Not safe
// for concurrent use; create one per request.
type Converter struct {
	db        DB
	profileID uuid.UUID
	cache     map[rateKey]rateHit
	missing   map[MissingRate]bool
}

type rateKey struct {
	from, to string
	on       time.Time
}

type rateHit struct {
	rate exchangerates.Rate
	ok   bool
}

func NewConverter(db DB, profileID uuid.UUID) *Converter {
	return &Converter{db: db, profileID: profileID, cache: map[rateKey]rateHit{}, missing: map[MissingRate]bool{}}
}

func (c *Converter) lookup(ctx context.Context, from, to string, on time.Time) (rateHit, error) {
	k := rateKey{from, to, on}
	if h, ok := c.cache[k]; ok {
		return h, nil
	}
	r, err := exchangerates.Lookup(ctx, c.db, c.profileID, from, to, Fmt(on))
	h := rateHit{rate: r, ok: err == nil}
	if err != nil && !errors.Is(err, exchangerates.ErrNoRate) {
		return h, err
	}
	c.cache[k] = h
	return h, nil
}

// Rate is the conversion factor from -> to valid on a date (units of `to` per 1 `from`).
func (c *Converter) Rate(ctx context.Context, from, to string, on time.Time) (*big.Rat, bool, error) {
	if from == to {
		return big.NewRat(1, 1), true, nil
	}
	h, err := c.lookup(ctx, from, to, on)
	if err != nil || !h.ok {
		return nil, false, err
	}
	r, _ := new(big.Rat).SetString(h.rate.Value())
	return r, true, nil
}

// Convert values m in `to` on date `on`. ok=false (and a recorded MissingRate) when no rate exists.
func (c *Converter) Convert(ctx context.Context, m money.Money, to string, on time.Time) (money.Money, bool, error) {
	if m.Currency() == to {
		return m, true, nil
	}
	h, err := c.lookup(ctx, m.Currency(), to, on)
	if err != nil {
		return money.Money{}, false, err
	}
	if !h.ok {
		c.missing[MissingRate{From: m.Currency(), To: to, Date: Fmt(on)}] = true
		return Zero(to), false, nil
	}
	out, err := h.rate.Convert(m, money.HalfUp)
	return out, err == nil, err
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
