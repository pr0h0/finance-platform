// Package currency: Currency definitions and the converter.
//
// Owned routes under /api/v1: /currencies, /convert
// See docs/api/openapi.yaml for the contract.
package currency

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/exchangerates"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

type Currency struct {
	Code       string `json:"code"`
	Name       string `json:"name"`
	MinorUnits int    `json:"minorUnits"`
	Symbol     string `json:"symbol"`
	IsActive   bool   `json:"isActive"`
}

type convertResult struct {
	From     money.Money `json:"from"`
	To       money.Money `json:"to"`
	Rate     string      `json:"rate"`
	RateDate string      `json:"rateDate"`
	Source   string      `json:"source"`
	Inverse  bool        `json:"inverse"`
	Stale    bool        `json:"stale"`
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	r.Get("/currencies", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		if _, err := authz.Require(r.Context()); err != nil {
			return err
		}
		rows, err := deps.DB.Query(r.Context(), `SELECT code, name, minor_units, symbol, is_active FROM currencies ORDER BY code`)
		if err != nil {
			return err
		}
		defer rows.Close()
		out := httpx.List[Currency]{Items: []Currency{}}
		for rows.Next() {
			var c Currency
			if err := rows.Scan(&c.Code, &c.Name, &c.MinorUnits, &c.Symbol, &c.IsActive); err != nil {
				return err
			}
			out.Items = append(out.Items, c)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))

	r.Post("/convert", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleViewer)
		if err != nil {
			return err
		}
		var in struct {
			Amount   *money.Money       `json:"amount"`
			To       string             `json:"to"`
			Date     string             `json:"date"`
			Rate     string             `json:"rate"`
			Rounding money.RoundingMode `json:"rounding"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		fields := map[string]string{}
		if in.Amount == nil {
			fields["amount"] = "required"
		}
		if _, ok := money.Scale(in.To); !ok {
			fields["to"] = "unknown currency"
		}
		if in.Rounding == "" {
			in.Rounding = money.DefaultRounding
		} else if !money.ValidMode(in.Rounding) {
			fields["rounding"] = "unknown rounding mode"
		}
		if in.Date != "" && ledger.ValidDate(in.Date) != nil {
			fields["date"] = "expected YYYY-MM-DD"
		}
		if in.Rate != "" {
			if err := exchangerates.ValidRate(in.Rate); err != nil {
				fields["rate"] = err.Error()
			}
		}
		if len(fields) > 0 {
			return httpx.Validation(fields)
		}
		if in.Date == "" {
			if in.Date, err = ledger.Today(r.Context(), deps.DB, profileID); err != nil {
				return err
			}
		}
		res := convertResult{From: *in.Amount, RateDate: in.Date}
		var rate exchangerates.Rate
		if in.Rate != "" {
			rate = exchangerates.Rate{From: in.Amount.Currency(), To: in.To, Stored: in.Rate, RateDate: in.Date, Source: "manual"}
		} else {
			rate, res.Stale, err = exchangerates.LookupOrFetch(r.Context(), deps.DB, deps.Config.FXProviders, profileID, in.Amount.Currency(), in.To, in.Date)
			if errors.Is(err, exchangerates.ErrNoRate) {
				return httpx.NewError(http.StatusUnprocessableEntity, "rate_unavailable", err.Error()+"; enter a manual rate")
			}
			if err != nil {
				return err
			}
		}
		if res.To, err = rate.Convert(*in.Amount, in.Rounding); err != nil {
			return err
		}
		res.Rate, res.RateDate, res.Source, res.Inverse = rate.Value(), rate.RateDate, rate.Source, rate.Inverse
		httpx.WriteJSON(w, http.StatusOK, res)
		return nil
	}))
}
