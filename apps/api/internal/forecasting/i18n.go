package forecasting

import (
	"regexp"
	"time"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
)

// bsText translates the fixed forecast texts (assumptions, warnings, event suffixes) for REST
// clients that asked for Bosnian. MCP keeps English. Each pattern must cover one Sprintf/literal in
// engine.go or module.go; TestLocalizeBosnian fails when a produced text has no pattern.
var bsText = []struct {
	re *regexp.Regexp
	bs string
}{
	{regexp.MustCompile(`^Starting balances are ledger balances in each account's own currency before any event today \((\S+)\)\.$`), "Početna stanja su knjigovodstvena stanja svakog računa u njegovoj valuti prije bilo kojeg današnjeg događaja ($1)."},
	{regexp.MustCompile(`^Expected: certain and expected events at their planned amounts\.$`), "Očekivano: sigurni i očekivani događaji u planiranim iznosima."},
	{regexp.MustCompile(`^Conservative: only certain income \(at its minimum\); every expense, including possible and speculative ones, at its maximum\.$`), "Konzervativno: samo sigurni prihodi (u minimalnom iznosu); svi rashodi, uključujući moguće i neizvjesne, u maksimalnom iznosu."},
	{regexp.MustCompile(`^Optimistic: all income at its maximum; only certain and expected expenses at their minimum\.$`), "Optimistično: svi prihodi u maksimalnom iznosu; samo sigurni i očekivani rashodi u minimalnom iznosu."},
	{regexp.MustCompile(`^Foreign-currency balances are converted to (\S+) at today's rate for the whole period; rates are assumed constant\.$`), "Stanja u stranim valutama preračunavaju se u $1 po današnjem kursu za cijeli period; kursevi se smatraju nepromijenjenim."},
	{regexp.MustCompile(`^Planned occurrences already matched to a transaction, paid manually or skipped are not counted again; stored pending occurrences in the past are assumed to happen today\.$`), "Planirane stavke koje su već povezane s transakcijom, ručno plaćene ili preskočene ne računaju se ponovo; zakašnjele stavke na čekanju uzimaju se kao da se dešavaju danas."},
	{regexp.MustCompile(`^Shortfalls are per account in its own currency: below zero, or below minus the credit limit for liability accounts with a limit\.$`), "Manjkovi se računaju po računu u njegovoj valuti: ispod nule, odnosno ispod negativnog kreditnog limita za račune obaveza s limitom."},
	{regexp.MustCompile(`^Uncertain forecasts are estimates, not guaranteed outcomes\.$`), "Neizvjesne prognoze su procjene, a ne zagarantovani ishodi."},
	{regexp.MustCompile(`^event (\S+) on (\S+) ignored: account not in forecast$`), "događaj $1 na dan $2 je izostavljen: račun nije u prognozi"},
	{regexp.MustCompile(`^event (\S+) on (\S+) ignored: currency differs from account$`), "događaj $1 na dan $2 je izostavljen: valuta se razlikuje od valute računa"},
	{regexp.MustCompile(`^account (\S+) \((\S+)\) left out: no (\S+) rate$`), "račun $1 ($2) je izostavljen: nema kursa $3"},
	{regexp.MustCompile(`^reserve ignored: no (\S+) rate$`), "rezerva je zanemarena: nema kursa $1"},
	{regexp.MustCompile(`^plan (\S+) has no account and is not forecast$`), "plan $1 nema račun i nije uključen u prognozu"},
	{regexp.MustCompile(`^transfer plan (\S+) has no destination account$`), "plan prenosa $1 nema odredišni račun"},
	{regexp.MustCompile(`^(\d+) overdue planned item\(s\) are assumed to happen today; match or skip them to refine the forecast\.$`), "$1 zakašnjelih planiranih stavki uzima se kao da se dešavaju danas; povežite ih ili preskočite da biste preciznije prognozirali."},
	{regexp.MustCompile(`^no accounts are included in this forecast$`), "nijedan račun nije uključen u ovu prognozu"},
	{regexp.MustCompile(`^Accounts: every non-archived account; safe-to-spend uses the accounts marked for it\.$`), "Računi: svi nearhivirani računi; iznos za slobodnu potrošnju koristi račune označene za to."},
	{regexp.MustCompile(`^Simulation: what-if adjustments are applied as certain; no records were changed\.$`), "Simulacija: \"šta ako\" promjene uzimaju se kao sigurne; nijedan zapis nije izmijenjen."},
	{regexp.MustCompile(`^Safe-to-spend = lowest conservative balance of the safe-to-spend accounts through (\S+) \(the day before the next expected income, at most 31 days\) minus the reserve of (.+) \(profile setting forecast\.minimumReserve or \?reserve=\)\.$`),
		"Slobodno za potrošnju = najniže konzervativno stanje računa za slobodnu potrošnju do $1 (dan prije sljedećeg očekivanog prihoda, najviše 31 dan) umanjeno za rezervu od $2 (postavka profila forecast.minimumReserve ili ?reserve=)."},
}

var overdueSuffix = regexp.MustCompile(` \(overdue since (\d{4}-\d{2}-\d{2})\)$`)

// translateBs returns the Bosnian text and whether a pattern matched.
func translateBs(s string) (string, bool) {
	for _, t := range bsText {
		if t.re.MatchString(s) {
			return t.re.ReplaceAllString(s, t.bs), true
		}
	}
	return s, false
}

// Localize rewrites the forecast's fixed texts in place for lang ("en" leaves them unchanged).
// Engine-level texts (assumptions from Project) without a pattern stay English.
func Localize(lang string, f *Forecast) {
	if lang != "bs" {
		return
	}
	for i, s := range f.Assumptions {
		f.Assumptions[i], _ = translateBs(s)
	}
	for i, s := range f.Warnings {
		f.Warnings[i], _ = translateBs(s)
	}
	for i := range f.Days {
		for j, e := range f.Days[i].Events {
			f.Days[i].Events[j].Description = overdueSuffix.ReplaceAllStringFunc(e.Description, func(m string) string {
				d := overdueSuffix.FindStringSubmatch(m)[1]
				if t, err := time.Parse(fin.DateLayout, d); err == nil {
					d = t.Format("02.01.2006.")
				}
				return " (kasni od " + d + ")"
			})
		}
	}
}
