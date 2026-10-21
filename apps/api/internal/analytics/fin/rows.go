package fin

import "github.com/pr0h0/finance-platform/apps/api/internal/money"

// Row is one line of an analytics result (OpenAPI AnalyticsRows.rows). Optional fields are set by
// the endpoints that need them (comparisons, planned vs actual, currency exposure, ratios).
type Row struct {
	Key       string       `json:"key"`
	Label     string       `json:"label"`
	Amount    money.Money  `json:"amount"`
	Count     int          `json:"count"`
	Period    string       `json:"period,omitempty"`
	ParentKey *string      `json:"parentKey,omitempty"`
	Previous  *money.Money `json:"previous,omitempty"`
	Change    *string      `json:"change,omitempty"` // (amount - previous) / |previous|, decimal string
	Planned   *money.Money `json:"planned,omitempty"`
	Actual    *money.Money `json:"actual,omitempty"`
	Variance  *money.Money `json:"variance,omitempty"`
	Allocated *money.Money `json:"allocated,omitempty"`
	Native    *money.Money `json:"native,omitempty"`
	Value     *string      `json:"value,omitempty"` // non-money metric (ratio, months)
}

// Rows is OpenAPI AnalyticsRows. Complete=false means some amounts could not be valued (see
// MissingRates) or the data has known gaps (Warnings); totals then exclude those amounts.
type Rows struct {
	Currency     string        `json:"currency"`
	From         string        `json:"from"`
	To           string        `json:"to"`
	Rows         []Row         `json:"rows"`
	Total        money.Money   `json:"total"`
	Complete     bool          `json:"complete"`
	Warnings     []string      `json:"warnings"`
	MissingRates []MissingRate `json:"missingRates"`
	incomplete   bool
}

// Gap records a known data gap: the result is marked incomplete with an explanation.
func (r *Rows) Gap(warning string) {
	r.incomplete = true
	r.Warnings = append(r.Warnings, warning)
}

// Finish fills completeness from the converter.
func (r *Rows) Finish(c *Converter) {
	if r.Rows == nil {
		r.Rows = []Row{}
	}
	if r.Warnings == nil {
		r.Warnings = []string{}
	}
	r.MissingRates = c.Missing()
	r.Complete = c.Complete() && !r.incomplete
	if len(r.MissingRates) > 0 {
		r.Warnings = append(r.Warnings, "some amounts have no exchange rate on their date and are excluded from totals")
	}
}

func Ptr[T any](v T) *T { return &v }
