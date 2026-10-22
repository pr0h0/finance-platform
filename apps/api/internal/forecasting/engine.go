package forecasting

import (
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
)

// Projection rules, identical to the TS engine (packages/forecasting/src/index.ts; shared cases in
// packages/test-fixtures/conformance/forecast.json, documented in docs/architecture/planning-analytics.md).
//
// Scenario rules for a dated event with signed amount a (optional AmountMin/AmountMax magnitudes):
//
//	expected:     included when confidence is certain|expected; amount a.
//	conservative: income only when certain (AmountMin ?? a); expenses always (AmountMax ?? a).
//	optimistic:   income always (AmountMax ?? a); expenses only when certain|expected (AmountMin ?? a).
//	transfers (both legs) use the expected rule in every scenario, so moving money between
//	included accounts never changes the total.
//
// Balances: Account.Balance is the balance before any event on From, in the account currency;
// each day's value is the end-of-day balance. Totals are in the forecast currency, every account
// valued at the From rate (constant-rate assumption); accounts without a rate are left out and the
// forecast is incomplete. Events whose currency differs from their account's are ignored (warning).
// Lowest = minimum expected total (earliest on ties). Shortfalls = per account, each run of days
// whose expected balance is below its floor (0, or -creditLimit for liabilities with a limit;
// liabilities without a limit never alert): first date and lowest balance in the account currency.
// MonthEnd = expected total on the last day of From's month (or To if earlier).
// SafeToSpend = max(0, lowest conservative total of the safe-to-spend accounts from From through
// SafeToSpendUntil - reserve); SafeToSpendUntil = the day before the first expected income after
// From, capped at From+31 days and To.

// Event is a dated money movement on one account. Amount is signed, in the account currency.
type Event struct {
	Date        time.Time
	AccountID   uuid.UUID
	Amount      money.Money
	AmountMin   *money.Money // positive magnitudes
	AmountMax   *money.Money
	Confidence  string
	Source      string // planned | recurring | installment | transfer | goal | scenario | posted
	SourceID    uuid.UUID
	Description string
}

// Account is one account of the forecast.
type Account struct {
	ID                   uuid.UUID
	Currency             string
	Balance              money.Money
	AccountType          string
	CreditLimit          *money.Money
	IncludeInSafeToSpend bool
}

// Input to Project. Convert values an account-currency amount in Currency at the From rate
// (ok=false: no rate).
type Input struct {
	From, To  time.Time
	Currency  string
	Accounts  []Account
	Events    []Event
	Convert   func(money.Money) (money.Money, bool)
	Reserve   *money.Money         // in Currency; nil = none
	DailyOnly func(time.Time) bool // nil = every day in Days; otherwise only matching days are listed
}

type DayEvent struct {
	Description string      `json:"description"`
	Amount      money.Money `json:"amount"`
	Confidence  string      `json:"confidence"`
	SourceID    uuid.UUID   `json:"sourceId"`
	AccountID   *uuid.UUID  `json:"accountId"`
	Kind        string      `json:"kind"`
	InExpected  bool        `json:"inExpected"`
}

type Day struct {
	Date         string      `json:"date"`
	Expected     money.Money `json:"expected"`
	Conservative money.Money `json:"conservative"`
	Optimistic   money.Money `json:"optimistic"`
	Events       []DayEvent  `json:"events"`
}

type Point struct {
	Date   string      `json:"date"`
	Amount money.Money `json:"amount"`
}

type Shortfall struct {
	Date      string      `json:"date"`      // first day below the account's floor
	Amount    money.Money `json:"amount"`    // lowest balance during the run, account currency
	AccountID *uuid.UUID  `json:"accountId"` // always set (per-account rule)
	Until     *string     `json:"until"`     // last day below the floor (nil = still below at the end)
	Scenario  string      `json:"scenario"`  // always "expected"
}

// Forecast is OpenAPI Forecast.
type Forecast struct {
	Currency           string            `json:"currency"`
	From               string            `json:"from"`
	To                 string            `json:"to"`
	Start              money.Money       `json:"start"`
	Days               []Day             `json:"days"`
	Lowest             Point             `json:"lowest"`
	LowestConservative Point             `json:"lowestConservative"`
	Shortfalls         []Shortfall       `json:"shortfalls"`
	MonthEnd           money.Money       `json:"monthEnd"`
	SafeToSpend        money.Money       `json:"safeToSpend"`
	SafeToSpendUntil   string            `json:"safeToSpendUntil"`
	Reserve            money.Money       `json:"reserve"`
	Assumptions        []string          `json:"assumptions"`
	Complete           bool              `json:"complete"`
	Warnings           []string          `json:"warnings"`
	MissingRates       []fin.MissingRate `json:"missingRates"`
}

var liabilityTypes = map[string]bool{"credit_card": true, "loan": true, "mortgage": true, "other_liability": true}

func likely(confidence string) bool { return confidence == "certain" || confidence == "expected" }

// ScenarioAmount is the signed amount of e in a scenario (expected | conservative | optimistic),
// or nil when the event is excluded from it.
func ScenarioAmount(e Event, scenario string) *money.Money {
	v := e.Amount
	if scenario == "expected" || e.Source == "transfer" {
		if likely(e.Confidence) {
			return &v
		}
		return nil
	}
	income := v.Sign() > 0
	pick := func(m *money.Money) *money.Money {
		if m == nil {
			return &v
		}
		x := *m
		if !income {
			x = x.Neg()
		}
		return &x
	}
	if scenario == "conservative" {
		if income {
			if e.Confidence == "certain" {
				return pick(e.AmountMin)
			}
			return nil
		}
		return pick(e.AmountMax)
	}
	if income {
		return pick(e.AmountMax)
	}
	if likely(e.Confidence) {
		return pick(e.AmountMin)
	}
	return nil
}

// isIncome: an expected inflow that is not a transfer leg or a simulation (ends the safe-to-spend horizon).
func isIncome(e Event) bool {
	return e.Amount.Sign() > 0 && likely(e.Confidence) && e.Source != "transfer" && e.Source != "scenario"
}

// SafeUntil is the safe-to-spend horizon: the day before the first expected income after from,
// at most from+31 days and to.
func SafeUntil(from, to time.Time, events []Event) time.Time {
	until := to
	if lim := from.AddDate(0, 0, 31); lim.Before(until) {
		until = lim
	}
	for _, e := range events {
		if isIncome(e) && e.Date.After(from) && !e.Date.After(to) {
			if d := e.Date.AddDate(0, 0, -1); d.Before(until) {
				until = d
			}
		}
	}
	return until
}

var scenarios = [3]string{"expected", "conservative", "optimistic"}

func dayKind(e Event) string {
	switch e.Source {
	case "transfer":
		return "transfer"
	case "posted":
		return "posted"
	case "scenario":
		return "adjustment"
	}
	if e.Amount.Sign() > 0 {
		return "income"
	}
	return "expense"
}

// Project runs the day-by-day projection. It is pure: same input, same output, no I/O.
func Project(in Input) Forecast {
	cur := in.Currency
	n := fin.DaysBetween(in.From, in.To) + 1
	if n < 1 {
		n = 1
	}
	f := Forecast{Currency: cur, From: fin.Fmt(in.From), To: fin.Fmt(in.To), Days: []Day{}, Shortfalls: []Shortfall{}, Warnings: []string{},
		Reserve: fin.Zero(cur)}
	accIdx := map[uuid.UUID]int{}
	for i, a := range in.Accounts {
		accIdx[a.ID] = i
	}
	// deltas[scenario][account][day]
	var deltas [3][]map[int]*fin.Accumulator
	for s := range deltas {
		deltas[s] = make([]map[int]*fin.Accumulator, len(in.Accounts))
		for a := range in.Accounts {
			deltas[s][a] = map[int]*fin.Accumulator{}
		}
	}
	events := append([]Event(nil), in.Events...)
	sort.SliceStable(events, func(i, j int) bool { return events[i].Date.Before(events[j].Date) })
	dayEvents := map[int][]DayEvent{}
	for _, e := range events {
		if e.Date.Before(in.From) || e.Date.After(in.To) {
			continue
		}
		ai, ok := accIdx[e.AccountID]
		if !ok {
			f.Warnings = append(f.Warnings, fmt.Sprintf("event %s on %s ignored: account not in forecast", e.SourceID, fin.Fmt(e.Date)))
			continue
		}
		if e.Amount.Currency() != in.Accounts[ai].Currency {
			f.Warnings = append(f.Warnings, fmt.Sprintf("event %s on %s ignored: currency differs from account", e.SourceID, fin.Fmt(e.Date)))
			continue
		}
		di := fin.DaysBetween(in.From, e.Date)
		for si, s := range scenarios {
			if v := ScenarioAmount(e, s); v != nil {
				m := deltas[si][ai]
				if m[di] == nil {
					m[di] = &fin.Accumulator{}
				}
				m[di].Add(*v)
			}
		}
		acc := e.AccountID
		dayEvents[di] = append(dayEvents[di], DayEvent{Description: e.Description, Amount: e.Amount, Confidence: e.Confidence, SourceID: e.SourceID,
			AccountID: &acc, Kind: dayKind(e), InExpected: ScenarioAmount(e, "expected") != nil})
	}

	// series[scenario][account][day]: end-of-day balance, account currency.
	var series [3][][]money.Money
	for si := range scenarios {
		series[si] = make([][]money.Money, len(in.Accounts))
		for ai, a := range in.Accounts {
			var bal fin.Accumulator
			bal.Add(a.Balance)
			row := make([]money.Money, n)
			for di := 0; di < n; di++ {
				if d := deltas[si][ai][di]; d != nil {
					bal.Add(d.Money(a.Currency))
				}
				row[di] = bal.Money(a.Currency)
			}
			series[si][ai] = row
		}
	}
	valued := make([]bool, len(in.Accounts))
	for ai, a := range in.Accounts {
		if a.Currency == cur {
			valued[ai] = true
		} else if _, ok := in.Convert(fin.Zero(a.Currency)); ok {
			valued[ai] = true
		} else {
			f.Warnings = append(f.Warnings, fmt.Sprintf("account %s (%s) left out: no %s/%s rate", a.ID, a.Currency, a.Currency, cur))
		}
	}
	rep := func(ai int, m money.Money) money.Money {
		if in.Accounts[ai].Currency == cur {
			return m
		}
		v, _ := in.Convert(m)
		return v
	}
	total := func(si, di int, safeOnly bool) money.Money {
		var t fin.Accumulator
		for ai, a := range in.Accounts {
			if valued[ai] && (!safeOnly || a.IncludeInSafeToSpend) {
				t.Add(rep(ai, series[si][ai][di]))
			}
		}
		return t.Money(cur)
	}
	var start fin.Accumulator
	for ai, a := range in.Accounts {
		if valued[ai] {
			start.Add(rep(ai, a.Balance))
		}
	}
	f.Start = start.Money(cur)

	meDate := fin.MonthEnd(in.From)
	if in.To.Before(meDate) {
		meDate = in.To
	}
	until := SafeUntil(in.From, in.To, events)
	var minSafe *money.Money
	for di := 0; di < n; di++ {
		d := in.From.AddDate(0, 0, di)
		day := Day{Date: fin.Fmt(d), Expected: total(0, di, false), Conservative: total(1, di, false), Optimistic: total(2, di, false),
			Events: dayEvents[di]}
		if day.Events == nil {
			day.Events = []DayEvent{}
		}
		if di == 0 || cmpM(day.Expected, f.Lowest.Amount) < 0 {
			f.Lowest = Point{Date: day.Date, Amount: day.Expected}
		}
		if di == 0 || cmpM(day.Conservative, f.LowestConservative.Amount) < 0 {
			f.LowestConservative = Point{Date: day.Date, Amount: day.Conservative}
		}
		if !d.After(until) {
			if s := total(1, di, true); minSafe == nil || cmpM(s, *minSafe) < 0 {
				minSafe = &s
			}
		}
		if d.Equal(meDate) {
			f.MonthEnd = day.Expected
		}
		if in.DailyOnly == nil || in.DailyOnly(d) {
			f.Days = append(f.Days, day)
		}
	}

	for ai, a := range in.Accounts {
		liability := liabilityTypes[a.AccountType]
		if liability && a.CreditLimit == nil {
			continue
		}
		floor := fin.Zero(a.Currency)
		if liability {
			floor = a.CreditLimit.Neg()
		}
		var run *Shortfall
		for di, v := range series[0][ai] {
			if cmpM(v, floor) < 0 {
				if run == nil {
					id := a.ID
					run = &Shortfall{Date: fin.Fmt(in.From.AddDate(0, 0, di)), Amount: v, AccountID: &id, Scenario: "expected"}
				} else if cmpM(v, run.Amount) < 0 {
					run.Amount = v
				}
			} else if run != nil {
				last := fin.Fmt(in.From.AddDate(0, 0, di-1))
				run.Until = &last
				f.Shortfalls = append(f.Shortfalls, *run)
				run = nil
			}
		}
		if run != nil {
			f.Shortfalls = append(f.Shortfalls, *run)
		}
	}
	sort.SliceStable(f.Shortfalls, func(i, j int) bool {
		if f.Shortfalls[i].Date != f.Shortfalls[j].Date {
			return f.Shortfalls[i].Date < f.Shortfalls[j].Date
		}
		return f.Shortfalls[i].AccountID.String() < f.Shortfalls[j].AccountID.String()
	})

	if in.Reserve != nil {
		if in.Reserve.Currency() == cur {
			f.Reserve = *in.Reserve
		} else if v, ok := in.Convert(*in.Reserve); ok {
			f.Reserve = v
		} else {
			f.Warnings = append(f.Warnings, fmt.Sprintf("reserve ignored: no %s/%s rate", in.Reserve.Currency(), cur))
		}
	}
	f.SafeToSpend = fin.Zero(cur)
	if minSafe != nil {
		if s, _ := minSafe.Sub(f.Reserve); s.Sign() > 0 {
			f.SafeToSpend = s
		}
	}
	f.SafeToSpendUntil = fin.Fmt(until)
	f.Complete = len(f.Warnings) == 0
	return f
}

// EventsFromPlans turns pending plan occurrences (planning.Pending with includeOverdue) into
// events, exactly like the TS eventsFromPlans: income +amount on the account, expense -amount,
// transfer -amount on the account and +amount on the destination. Plans without an account are
// not forecast (warning). Overdue occurrences say so in their description.
func EventsFromPlans(plans []planning.Plan, occ []planning.Occurrence) ([]Event, []string) {
	byID := map[uuid.UUID]planning.Plan{}
	for _, p := range plans {
		byID[p.ID] = p
	}
	var events []Event
	var warnings []string
	for _, o := range occ {
		p := byID[o.PlannedTransactionID]
		if p.AccountID == nil {
			warnings = append(warnings, fmt.Sprintf("plan %s has no account and is not forecast", p.ID))
			continue
		}
		source := "planned"
		switch {
		case p.Kind == "transfer":
			source = "transfer"
		case p.InstallmentTotal != nil:
			source = "installment"
		case p.RecurrenceID != nil:
			source = "recurring"
		}
		desc := p.Description
		if o.Overdue {
			desc += " (overdue since " + o.NominalDate + ")"
		}
		base := Event{Date: o.Day, Confidence: p.Confidence, Source: source, SourceID: p.ID, Description: desc, AmountMin: p.AmountMin, AmountMax: p.AmountMax}
		out := base
		out.AccountID, out.Amount = *p.AccountID, o.Amount.Neg()
		if p.Kind == "income" {
			out.Amount = o.Amount
		}
		events = append(events, out)
		if p.Kind == "transfer" {
			if p.ToAccountID == nil {
				warnings = append(warnings, fmt.Sprintf("transfer plan %s has no destination account", p.ID))
				continue
			}
			in := base
			in.AccountID, in.Amount = *p.ToAccountID, o.Amount
			events = append(events, in)
		}
	}
	return events, warnings
}

func cmpM(a, b money.Money) int {
	c, _ := a.Cmp(b)
	return c
}
