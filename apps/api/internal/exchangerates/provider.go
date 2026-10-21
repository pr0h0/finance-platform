package exchangerates

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// Provider is an exchange_rate_providers row.
type Provider struct {
	ID            uuid.UUID  `json:"id"`
	Code          string     `json:"code"`
	Name          string     `json:"name"`
	Kind          string     `json:"kind"`
	Enabled       bool       `json:"enabled"`
	Priority      int        `json:"priority"`
	LastFetchedAt *time.Time `json:"lastFetchedAt"`
	LastError     *string    `json:"lastError"`
	config        providerConfig
}

// providerConfig of an http provider. The only wire format implemented is the Frankfurter/ECB API
// (GET {url}/{YYYY-MM-DD|latest}?base=EUR -> {"base","date","rates":{"USD":1.0823,...}}).
type providerConfig struct {
	URL  string `json:"url"`
	Base string `json:"base"`
}

// attempts remembers on-demand historical fetches per provider/date (process-local).
var attempts sync.Map

var httpClient = &http.Client{Timeout: 15 * time.Second}

const providerCols = `id, code, name, kind, enabled, priority, last_fetched_at, last_error, config`

func scanProvider(row interface{ Scan(...any) error }) (Provider, error) {
	var p Provider
	var cfg []byte
	err := row.Scan(&p.ID, &p.Code, &p.Name, &p.Kind, &p.Enabled, &p.Priority, &p.LastFetchedAt, &p.LastError, &cfg)
	if err == nil && len(cfg) > 0 {
		_ = json.Unmarshal(cfg, &p.config)
	}
	return p, err
}

// Fetch downloads the rates of an http provider for date ("" = latest) and stores new snapshots.
// Existing snapshots are never updated in place. Records last_fetched_at / last_error on the provider.
// Returns the number of snapshots inserted.
func Fetch(ctx context.Context, db *pgxpool.Pool, p Provider, date string) (int, error) {
	n, err := fetch(ctx, db, p, date)
	if err != nil {
		msg := err.Error()
		_, _ = db.Exec(ctx, `UPDATE exchange_rate_providers SET last_error = $2 WHERE id = $1`, p.ID, msg)
		return 0, err
	}
	_, _ = db.Exec(ctx, `UPDATE exchange_rate_providers SET last_fetched_at = now(), last_error = NULL WHERE id = $1`, p.ID)
	return n, nil
}

func fetch(ctx context.Context, db *pgxpool.Pool, p Provider, date string) (int, error) {
	if p.Kind != "http" || p.config.URL == "" {
		return 0, fmt.Errorf("provider %s is not an http provider", p.Code)
	}
	base := p.config.Base
	if base == "" {
		base = "EUR"
	}
	path := "latest"
	if date != "" {
		if err := ledger.ValidDate(date); err != nil {
			return 0, err
		}
		path = date
	}
	u := strings.TrimRight(p.config.URL, "/") + "/" + path + "?base=" + url.QueryEscape(base)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("fetch %s: %w", p.Code, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("fetch %s: HTTP %d", p.Code, resp.StatusCode)
	}
	var body struct {
		Base  string                 `json:"base"`
		Date  string                 `json:"date"`
		Rates map[string]json.Number `json:"rates"` // json.Number keeps the decimal text: never a float
	}
	dec := json.NewDecoder(io.LimitReader(resp.Body, 1<<20))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil {
		return 0, fmt.Errorf("fetch %s: decode: %w", p.Code, err)
	}
	if body.Base != base || ledger.ValidDate(body.Date) != nil {
		return 0, fmt.Errorf("fetch %s: unexpected response", p.Code)
	}
	codes := make([]string, 0, len(body.Rates))
	for c := range body.Rates {
		codes = append(codes, c)
	}
	slices.Sort(codes)
	inserted := 0
	for _, quote := range codes {
		rate := body.Rates[quote].String()
		if _, ok := money.Scale(quote); !ok || quote == base || ValidRate(rate) != nil {
			continue // unknown currency or malformed number: skip, never guess
		}
		tag, err := db.Exec(ctx, `INSERT INTO exchange_rates (provider_id, base_currency, quote_currency, rate, rate_date, source)
			SELECT $1, $2, $3, $4::numeric, $5::date, 'provider' WHERE EXISTS (SELECT 1 FROM currencies WHERE code = $3)
			ON CONFLICT DO NOTHING`, p.ID, base, quote, rate, body.Date)
		if err != nil {
			return inserted, fmt.Errorf("store rate %s/%s: %w", base, quote, err)
		}
		inserted += int(tag.RowsAffected())
	}
	return inserted, nil
}

// EnabledHTTPProviders lists enabled http providers whose code is in codes (FX_PROVIDERS), by priority.
func EnabledHTTPProviders(ctx context.Context, db ledger.DB, codes []string) ([]Provider, error) {
	rows, err := db.Query(ctx, `SELECT `+providerCols+` FROM exchange_rate_providers
		WHERE kind = 'http' AND enabled AND code = ANY($1) ORDER BY priority, code`, codes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Provider
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// refresher fetches the latest rates of the configured providers on start and every interval.
// Failures are logged and recorded on the provider; lookups keep using cached snapshots (offline mode).
func refresher(db *pgxpool.Pool, codes []string, every time.Duration, log *slog.Logger) {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		ps, err := EnabledHTTPProviders(ctx, db, codes)
		if err != nil {
			log.Warn("fx refresh: list providers", "err", err)
		}
		for _, p := range ps {
			if n, err := Fetch(ctx, db, p, ""); err != nil {
				log.Warn("fx refresh failed; using cached rates", "provider", p.Code, "err", err)
			} else {
				log.Info("fx refresh", "provider", p.Code, "inserted", n)
			}
		}
		cancel()
		time.Sleep(every)
	}
}

// LookupOrFetch is Lookup plus, when the best snapshot is older than the requested date by more than
// a few days (weekends/holidays have no ECB rates), one attempt to fetch that date from the configured
// providers. If fetching fails the cached (stale) rate is returned with stale=true: offline fallback.
func LookupOrFetch(ctx context.Context, db *pgxpool.Pool, codes []string, profileID uuid.UUID, from, to, date string) (Rate, bool, error) {
	r, err := Lookup(ctx, db, profileID, from, to, date)
	if err == nil && !olderThan(r.RateDate, date, 4) {
		return r, false, nil
	}
	ps, perr := EnabledHTTPProviders(ctx, db, codes)
	fetched := false
	for _, p := range ps {
		key := p.Code + "/" + date
		if last, ok := attempts.Load(key); ok && time.Since(last.(time.Time)) < 10*time.Minute {
			continue // recently tried: do not hammer an unreachable provider (offline mode)
		}
		attempts.Store(key, time.Now())
		if _, ferr := Fetch(ctx, db, p, date); ferr == nil {
			fetched = true
		}
	}
	if fetched || perr != nil {
		if r2, err2 := Lookup(ctx, db, profileID, from, to, date); err2 == nil {
			return r2, olderThan(r2.RateDate, date, 4), nil
		}
	}
	return r, err == nil, err
}

func olderThan(rateDate, date string, days int) bool {
	a, err1 := time.Parse(time.DateOnly, rateDate)
	b, err2 := time.Parse(time.DateOnly, date)
	return err1 == nil && err2 == nil && b.Sub(a) > time.Duration(days)*24*time.Hour
}
