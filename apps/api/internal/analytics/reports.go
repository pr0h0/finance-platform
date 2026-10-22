package analytics

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"strings"
	"time"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// Report is the JSON form of /reports/{kind}.
type Report struct {
	Kind             string            `json:"kind"`
	From             string            `json:"from"`
	To               string            `json:"to"`
	Currency         string            `json:"currency"`
	Income           money.Money       `json:"income"`
	Expenses         money.Money       `json:"expenses"`
	Net              money.Money       `json:"net"`
	SavingsRate      *string           `json:"savingsRate"`
	ByCategory       []fin.Row         `json:"byCategory"`
	TopMerchants     []fin.Row         `json:"topMerchants"`
	IncomeVsExpenses []fin.Row         `json:"incomeVsExpenses"`
	NetWorth         []fin.Row         `json:"netWorth"`
	Complete         bool              `json:"complete"`
	Warnings         []string          `json:"warnings"`
	MissingRates     []fin.MissingRate `json:"missingRates"`
	GeneratedAt      string            `json:"generatedAt"`
}

// ReportRange resolves the period of a report kind: monthly (month of `from`, default last full
// month), quarterly, annual, or custom (from/to required).
func ReportRange(kind string, from, to *time.Time, today time.Time) (time.Time, time.Time, error) {
	ref := fin.MonthStart(today).AddDate(0, -1, 0)
	if from != nil {
		ref = *from
	}
	switch kind {
	case "monthly":
		return fin.MonthStart(ref), fin.MonthEnd(ref), nil
	case "quarterly":
		q := (int(ref.Month()) - 1) / 3
		s := fin.Date(ref.Year(), time.Month(q*3+1), 1)
		return s, fin.MonthEnd(s.AddDate(0, 2, 0)), nil
	case "annual":
		if from == nil {
			ref = fin.Date(today.Year()-1, 1, 1)
		}
		return fin.Date(ref.Year(), 1, 1), fin.Date(ref.Year(), 12, 31), nil
	case "custom":
		if from == nil || to == nil || to.Before(*from) || fin.DaysBetween(*from, *to) > 3660 {
			return ref, ref, fmt.Errorf("custom reports need from <= to (at most 10 years)")
		}
		return *from, *to, nil
	}
	return ref, ref, fmt.Errorf("unknown report kind %q (monthly, quarterly, annual, custom)", kind)
}

func BuildReport(ctx context.Context, db fin.DB, q Query, kind string) (Report, error) {
	rep := Report{Kind: kind, From: fin.Fmt(q.From), To: fin.Fmt(q.To), Currency: q.Currency, GeneratedAt: fin.Now().UTC().Format(time.RFC3339), Complete: true}
	interval := "month"
	if kind == "monthly" {
		interval = "week"
	}
	all := q
	all.Interval = "none"
	ive, err := IncomeVsExpenses(ctx, db, all)
	if err != nil {
		return rep, err
	}
	for _, r := range ive.Rows {
		switch {
		case strings.HasSuffix(r.Key, ":income"):
			rep.Income = r.Amount
		case strings.HasSuffix(r.Key, ":expenses"):
			rep.Expenses = r.Amount
		case strings.HasSuffix(r.Key, ":net"):
			rep.Net = r.Amount
		}
	}
	if s := fin.Ratio(rep.Net, rep.Income, 4); s != "" && rep.Income.Sign() > 0 {
		rep.SavingsRate = &s
	}
	cq := all
	cq.GroupBy = "parent"
	cat, err := SpendingByCategory(ctx, db, cq)
	if err != nil {
		return rep, err
	}
	rep.ByCategory = cat.Rows
	mer, err := SpendingByMerchant(ctx, db, all)
	if err != nil {
		return rep, err
	}
	rep.TopMerchants = mer.Rows[:min(10, len(mer.Rows))]
	iq := q
	iq.Interval = interval
	series, err := IncomeVsExpenses(ctx, db, iq)
	if err != nil {
		return rep, err
	}
	rep.IncomeVsExpenses = series.Rows
	nq := q
	nq.Interval = "month"
	nw, err := NetWorth(ctx, db, nq)
	if err != nil {
		return rep, err
	}
	rep.NetWorth = nw.Rows
	for _, r := range []fin.Rows{ive, cat, mer, series, nw} {
		rep.Complete = rep.Complete && r.Complete
		rep.Warnings = append(rep.Warnings, r.Warnings...)
		rep.MissingRates = append(rep.MissingRates, r.MissingRates...)
	}
	rep.Warnings = dedupe(rep.Warnings)
	if rep.MissingRates == nil {
		rep.MissingRates = []fin.MissingRate{}
	}
	return rep, nil
}

func dedupe(xs []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

// bsReport is the Bosnian text of the report's fixed labels, the system row labels and the constant
// warnings of the analytics queries (lang=bs). Anything not listed (user names, dynamic text) stays as is.
var bsReport = map[string]string{
	"Income": "Prihodi", "Expenses": "Rashodi", "Net cash flow": "Neto novčani tok", "Savings rate": "Stopa štednje",
	"Spending by category": "Potrošnja po kategorijama", "Top merchants": "Najveći trgovci",
	"Income vs expenses": "Prihodi i rashodi", "Net worth": "Neto vrijednost", "Assets": "Imovina",
	"Liabilities": "Obaveze", "Uncategorized": "Bez kategorije", "Spending": "Potrošnja", "Savings": "Štednja",
	"Currency": "Valuta", "Generated": "Generisano", "Incomplete data": "Nepotpuni podaci",
	"Financial report": "Finansijski izvještaj", "monthly": "mjesečni", "quarterly": "kvartalni",
	"annual": "godišnji", "custom": "prilagođeni",
	"the last period is not over yet":                                               "posljednji period još nije završen",
	"some amounts have no exchange rate on their date and are excluded from totals": "neki iznosi nemaju kurs na svoj datum i nisu uračunati u ukupne iznose",
}

// tr translates a fixed report string; lang is "en" or "bs".
func tr(lang, s string) string {
	if v, ok := bsReport[s]; ok && lang == "bs" {
		return v
	}
	return s
}

// reportDate renders YYYY-MM-DD for the report language (bs: DD.MM.YYYY.).
func reportDate(lang, d string) string {
	if t, err := time.Parse(fin.DateLayout, d); err == nil && lang == "bs" {
		return t.Format("02.01.2006.")
	}
	return d
}

func (r Report) warningText(lang string) string {
	ws := make([]string, len(r.Warnings))
	for i, w := range r.Warnings {
		ws[i] = tr(lang, w)
	}
	return strings.Join(ws, "; ")
}

// lines renders the report as (section, label, period, amount, count) records shared by CSV and PDF.
// Column names and section codes stay English (machine-readable); labels follow lang.
func (r Report) lines(lang string) [][]string {
	out := [][]string{{"section", "label", "period", "amount", "currency", "count"}}
	add := func(sec, label, period string, m money.Money, n int) {
		out = append(out, []string{sec, tr(lang, label), period, m.Amount(), m.Currency(), fmt.Sprint(n)})
	}
	add("summary", "Income", r.From+".."+r.To, r.Income, 0)
	add("summary", "Expenses", r.From+".."+r.To, r.Expenses, 0)
	add("summary", "Net cash flow", r.From+".."+r.To, r.Net, 0)
	if r.SavingsRate != nil {
		out = append(out, []string{"summary", tr(lang, "Savings rate"), r.From + ".." + r.To, *r.SavingsRate, "", "0"})
	}
	for _, x := range r.ByCategory {
		add("category", x.Label, x.Period, x.Amount, x.Count)
	}
	for _, x := range r.TopMerchants {
		add("merchant", x.Label, x.Period, x.Amount, x.Count)
	}
	for _, x := range r.IncomeVsExpenses {
		add("cash_flow", x.Label, x.Period, x.Amount, x.Count)
	}
	for _, x := range r.NetWorth {
		add("net_worth", x.Label, x.Period, x.Amount, 0)
	}
	if !r.Complete {
		out = append(out, []string{"warning", tr(lang, "Incomplete data") + ": " + r.warningText(lang), "", "", "", ""})
	}
	return out
}

// CSV renders the report (amounts as exact decimal strings).
func (r Report) CSV(lang string) []byte {
	var b bytes.Buffer
	w := csv.NewWriter(&b)
	for _, l := range r.lines(lang) {
		for i, cell := range l {
			// guard against spreadsheet formula injection from user-entered labels
			if len(cell) > 0 && strings.ContainsRune("=+-@\t\r", rune(cell[0])) && !isNumber(cell) {
				l[i] = "'" + cell
			}
		}
		_ = w.Write(l)
	}
	w.Flush()
	return b.Bytes()
}

func isNumber(s string) bool {
	_, err := money.RoundDecimal(s, 18, money.HalfUp)
	return err == nil
}

// PDF renders the report as text pages with embedded Unicode fonts (see pdf.go).
func (r Report) PDF(lang string) []byte {
	l := func(s string) string { return tr(lang, s) }
	text := []pdfLine{
		{fmt.Sprintf("%s (%s) %s .. %s", l("Financial report"), l(r.Kind), reportDate(lang, r.From), reportDate(lang, r.To)), true},
		{l("Currency") + ": " + r.Currency + "   " + l("Generated") + ": " + r.GeneratedAt, false}, {},
		{l("Income") + ": " + r.Income.Amount(), false}, {l("Expenses") + ": " + r.Expenses.Amount(), false}, {l("Net cash flow") + ": " + r.Net.Amount(), false},
	}
	if r.SavingsRate != nil {
		text = append(text, pdfLine{l("Savings rate") + ": " + pct(*r.SavingsRate) + "%", false})
	}
	section := func(title string, rows []fin.Row) {
		text = append(text, pdfLine{}, pdfLine{l(title), true})
		for _, x := range rows {
			p := ""
			if x.Period != "" {
				p = x.Period + "  "
			}
			text = append(text, pdfLine{fmt.Sprintf("  %s%s: %s", p, l(x.Label), x.Amount.Amount()), false})
		}
	}
	section("Spending by category", r.ByCategory)
	section("Top merchants", r.TopMerchants)
	section("Income vs expenses", r.IncomeVsExpenses)
	section("Net worth", r.NetWorth)
	if !r.Complete {
		text = append(text, pdfLine{}, pdfLine{strings.ToUpper(l("Incomplete data")) + ": " + r.warningText(lang), true})
	}
	return writePDF(text)
}
