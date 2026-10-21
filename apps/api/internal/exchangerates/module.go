// Package exchangerates: Exchange-rate providers, snapshots, manual overrides.
//
// Owned routes under /api/v1: /exchange-rates, /exchange-rate-providers
// See docs/api/openapi.yaml for the contract.
package exchangerates

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// ExchangeRate is the API shape of a snapshot.
type ExchangeRate struct {
	ID            uuid.UUID  `json:"id"`
	ProviderCode  *string    `json:"providerCode"`
	ProfileID     *uuid.UUID `json:"profileId"`
	BaseCurrency  string     `json:"baseCurrency"`
	QuoteCurrency string     `json:"quoteCurrency"`
	Rate          string     `json:"rate"`
	RateDate      string     `json:"rateDate"`
	Source        string     `json:"source"`
	FetchedAt     time.Time  `json:"fetchedAt"`
}

const rateCols = `er.id, p.code, er.profile_id, er.base_currency, er.quote_currency, er.rate::text, er.rate_date::text, er.source, er.fetched_at`

func scanRate(row interface{ Scan(...any) error }) (ExchangeRate, error) {
	var e ExchangeRate
	err := row.Scan(&e.ID, &e.ProviderCode, &e.ProfileID, &e.BaseCurrency, &e.QuoteCurrency, &e.Rate, &e.RateDate, &e.Source, &e.FetchedAt)
	e.Rate = ledger.TrimDecimal(e.Rate)
	return e, err
}

// Register mounts this module's routes on the /api/v1 router. When background jobs are enabled it also
// starts the periodic provider refresh (FX_PROVIDERS every FX_REFRESH_INTERVAL).
func Register(r chi.Router, deps *app.Deps) {
	if deps.Config.JobsEnabled && deps.Config.FXRefreshInterval > 0 && deps.DB != nil {
		go refresher(deps.DB, deps.Config.FXProviders, deps.Config.FXRefreshInterval, deps.Log)
	}
	r.Get("/exchange-rates", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleViewer)
		if err != nil {
			return err
		}
		page, err := httpx.ParsePage(r, 100, 500)
		if err != nil {
			return err
		}
		var cur struct {
			D  string    `json:"d"`
			ID uuid.UUID `json:"i"`
		}
		if err := httpx.DecodeCursor(page.Cursor, &cur); err != nil {
			return err
		}
		q := r.URL.Query()
		for _, k := range []string{"from", "to"} {
			if v := q.Get(k); v != "" && ledger.ValidDate(v) != nil {
				return httpx.Validation(map[string]string{k: "expected YYYY-MM-DD"})
			}
		}
		args := []any{profileID, q.Get("base"), q.Get("quote"), q.Get("from"), q.Get("to"), page.Limit + 1, page.Cursor != "", cur.D, cur.ID}
		rows, err := deps.DB.Query(r.Context(), `SELECT `+rateCols+` FROM exchange_rates er
			LEFT JOIN exchange_rate_providers p ON p.id = er.provider_id
			WHERE (er.profile_id IS NULL OR er.profile_id = $1)
			  AND ($2 = '' OR er.base_currency = $2) AND ($3 = '' OR er.quote_currency = $3)
			  AND ($4 = '' OR er.rate_date >= NULLIF($4, '')::date) AND ($5 = '' OR er.rate_date <= NULLIF($5, '')::date)
			  AND (NOT $7 OR (er.rate_date, er.id) < (NULLIF($8, '')::date, $9))
			ORDER BY er.rate_date DESC, er.id DESC LIMIT $6`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		out := httpx.List[ExchangeRate]{Items: []ExchangeRate{}}
		for rows.Next() {
			e, err := scanRate(rows)
			if err != nil {
				return err
			}
			out.Items = append(out.Items, e)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(out.Items) > page.Limit {
			out.Items = out.Items[:page.Limit]
			last := out.Items[page.Limit-1]
			out.NextCursor = httpx.EncodeCursor(struct {
				D  string    `json:"d"`
				ID uuid.UUID `json:"i"`
			}{last.RateDate, last.ID})
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))

	r.With(httpx.Idempotent(deps.DB)).Post("/exchange-rates", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in struct {
			BaseCurrency  string `json:"baseCurrency"`
			QuoteCurrency string `json:"quoteCurrency"`
			Rate          string `json:"rate"`
			RateDate      string `json:"rateDate"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		fields := map[string]string{}
		if _, ok := money.Scale(in.BaseCurrency); !ok {
			fields["baseCurrency"] = "unknown currency"
		}
		if _, ok := money.Scale(in.QuoteCurrency); !ok || in.QuoteCurrency == in.BaseCurrency {
			fields["quoteCurrency"] = "unknown currency or same as base"
		}
		if err := ValidRate(in.Rate); err != nil {
			fields["rate"] = err.Error()
		}
		if err := ledger.ValidDate(in.RateDate); err != nil {
			fields["rateDate"] = err.Error()
		}
		if len(fields) > 0 {
			return httpx.Validation(fields)
		}
		var id uuid.UUID
		err = deps.DB.QueryRow(r.Context(), `INSERT INTO exchange_rates (provider_id, profile_id, base_currency, quote_currency, rate, rate_date, source)
			SELECT p.id, $1, $2, $3, $4::numeric, $5::date, 'manual' FROM exchange_rate_providers p WHERE p.code = 'manual'
			RETURNING id`, profileID, in.BaseCurrency, in.QuoteCurrency, in.Rate, in.RateDate).Scan(&id)
		if ledger.IsUnique(err) {
			return httpx.Conflict("a manual rate for this pair and date exists; delete it first")
		}
		if err != nil {
			return err
		}
		e, err := scanRate(deps.DB.QueryRow(r.Context(), `SELECT `+rateCols+` FROM exchange_rates er
			LEFT JOIN exchange_rate_providers p ON p.id = er.provider_id WHERE er.id = $1`, id))
		if err != nil {
			return err
		}
		if err := changes.Audit(r.Context(), deps.DB, changes.Entry{ProfileID: &profileID, Action: "exchange_rate.create",
			EntityType: "exchange_rates", EntityID: &id, After: e}); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, e)
		return nil
	}))

	r.Delete("/exchange-rates/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleEditor)
		if err != nil {
			return err
		}
		id, err := ledger.IDParam(r, "id", "exchange rate")
		if err != nil {
			return err
		}
		var used bool
		err = deps.DB.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM postings WHERE exchange_rate_id = $1)
			OR EXISTS (SELECT 1 FROM currency_conversions WHERE exchange_rate_id = $1)
			FROM exchange_rates WHERE id = $1 AND profile_id = $2 AND source = 'manual'`, id, profileID).Scan(&used)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.NotFound("exchange rate")
		}
		if err != nil {
			return err
		}
		if used {
			return httpx.Conflict("this rate is referenced by recorded transactions and is kept as history")
		}
		if _, err := deps.DB.Exec(r.Context(), `DELETE FROM exchange_rates WHERE id = $1 AND profile_id = $2`, id, profileID); err != nil {
			return err
		}
		if err := changes.Audit(r.Context(), deps.DB, changes.Entry{ProfileID: &profileID, Action: "exchange_rate.delete",
			EntityType: "exchange_rates", EntityID: &id}); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))

	r.Get("/exchange-rate-providers", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		if _, err := authz.Require(r.Context()); err != nil {
			return err
		}
		rows, err := deps.DB.Query(r.Context(), `SELECT `+providerCols+` FROM exchange_rate_providers ORDER BY priority, code`)
		if err != nil {
			return err
		}
		defer rows.Close()
		out := httpx.List[Provider]{Items: []Provider{}}
		for rows.Next() {
			p, err := scanProvider(rows)
			if err != nil {
				return err
			}
			out.Items = append(out.Items, p)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))

	r.Post("/exchange-rate-providers/{id}/refresh", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		if _, err := authz.RequireAdmin(r.Context()); err != nil {
			return err
		}
		id, err := ledger.IDParam(r, "id", "provider")
		if err != nil {
			return err
		}
		p, err := scanProvider(deps.DB.QueryRow(r.Context(), `SELECT `+providerCols+` FROM exchange_rate_providers WHERE id = $1`, id))
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.NotFound("provider")
		}
		if err != nil {
			return err
		}
		date := r.URL.Query().Get("date")
		if _, err := Fetch(r.Context(), deps.DB, p, date); err != nil {
			e := httpx.NewError(http.StatusBadGateway, "provider_unavailable", err.Error())
			return e
		}
		_ = changes.Audit(r.Context(), deps.DB, changes.Entry{Action: "exchange_rate_provider.refresh", EntityType: "exchange_rate_providers",
			EntityID: &id, Metadata: map[string]any{"date": date}})
		p, err = scanProvider(deps.DB.QueryRow(r.Context(), `SELECT `+providerCols+` FROM exchange_rate_providers WHERE id = $1`, id))
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, p)
		return nil
	}))
}
