package forecasting

import (
	"sort"
	"time"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// Scenario rules for uncertain events (documented in docs/architecture/planning-analytics.md):
//
//	                 income included          expense included              variable amount
//	expected         certain, expected        certain, expected, possible   planned amount
//	conservative     certain only             every confidence              income min / expense max
//	optimistic       certain..possible        certain, expected             income max / expense min
//
// Ledger transactions already booked in the future and what-if adjustments are certain.
// Transfers follow the expense rule on both legs so a transfer never half-happens.

// Event is a dated money movement on one account (AccountID nil = not tied to an included
// account; it moves only the total). Amounts are signed, in the forecast currency.
type Event struct {
	Date         time.Time
	AccountID    *uuid.UUID
	Expected     *money.Money // nil = excluded from that scenario
	Conservative *money.Money
	Optimistic   *money.Money
	Description  string
	Confidence   string
	SourceID     uuid.UUID
	Kind         string // income | expense | transfer | posted | adjustment
}

// Scenarios builds the three scenario amounts from a plan occurrence (amount positive magnitude).
// sign: +1 inflow, -1 outflow.
func Scenarios(sign int, kind, confidence string, amount money.Money, amin, amax *money.Money) (exp, cons, opt *money.Money) {
	signed := func(m money.Money) *money.Money {
		if sign < 0 {
			m = m.Neg()
		}
		return &m
	}
	low, high := amount, amount
	if amin != nil {
		low = *amin
	}
	if amax != nil {
		high = *amax
	}
	if kind == "income" {
		if fin.OneOf(confidence, "certain", "expected") {
			exp = signed(amount)
		}
		if confidence == "certain" {
			cons = signed(low)
		}
		if fin.OneOf(confidence, "certain", "expected", "possible") {
			opt = signed(high)
		}
		return
	}
	if fin.OneOf(confidence, "certain", "expected", "possible") {
		exp = signed(amount)
	}
	cons = signed(high)
	if fin.OneOf(confidence, "certain", "expected") {
		opt = signed(low)
	}
	return
}

// Certain is an event amount included in every scenario.
func Certain(m money.Money) (exp, cons, opt *money.Money) { return &m, &m, &m }

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
	Date      string      `json:"date"`      // first day below zero
	Amount    money.Money `json:"amount"`    // lowest balance during the shortfall
	AccountID *uuid.UUID  `json:"accountId"` // nil = all included accounts together
	Until     *string     `json:"until"`     // last negative day (nil = still negative at the end)
	Scenario  string      `json:"scenario"`
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

// Input to Project.
type Input struct {
	From, To  time.Time
	Currency  string
	Start     map[uuid.UUID]money.Money // included accounts, in Currency
	Events    []Event
	Reserve   money.Money
	MonthEnd  time.Time            // date whose expected balance is reported as monthEnd
	DailyOnly func(time.Time) bool // nil = every day in Days; otherwise only matching days are listed
}

// Project runs the day-by-day projection. It is pure: same input, same output, no I/O.
func Project(in Input) Forecast {
	cur := in.Currency
	f := Forecast{Currency: cur, From: fin.Fmt(in.From), To: fin.Fmt(in.To), Days: []Day{}, Shortfalls: []Shortfall{}, Reserve: in.Reserve}
	events := append([]Event(nil), in.Events...)
	sort.SliceStable(events, func(i, j int) bool { return events[i].Date.Before(events[j].Date) })

	ids := make([]uuid.UUID, 0, len(in.Start))
	for id := range in.Start {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	exp := map[uuid.UUID]*fin.Accumulator{}
	var totE, totC, totO fin.Accumulator
	for _, id := range ids {
		a := &fin.Accumulator{}
		a.Add(in.Start[id])
		exp[id] = a
		totE.Add(in.Start[id])
		totC.Add(in.Start[id])
		totO.Add(in.Start[id])
	}
	f.Start = totE.Money(cur)
	type run struct {
		idx  int
		last time.Time
		open bool
	}
	runs := map[string]*run{}
	track := func(key string, acc *uuid.UUID, scenario string, bal money.Money, d time.Time) {
		r := runs[key]
		switch {
		case bal.Sign() < 0:
			if r == nil || !r.open {
				f.Shortfalls = append(f.Shortfalls, Shortfall{Date: fin.Fmt(d), Amount: bal, AccountID: acc, Scenario: scenario})
				r = &run{idx: len(f.Shortfalls) - 1, open: true}
				runs[key] = r
			}
			if s := &f.Shortfalls[r.idx]; cmpM(bal, s.Amount) < 0 {
				s.Amount = bal
			}
			r.last = d
		case r != nil && r.open:
			r.open = false
			last := fin.Fmt(r.last)
			f.Shortfalls[r.idx].Until = &last
		}
	}

	f.MonthEnd = totE.Money(cur)
	first := true
	i := 0
	for d := in.From; !d.After(in.To); d = d.AddDate(0, 0, 1) {
		day := Day{Date: fin.Fmt(d), Events: []DayEvent{}}
		for ; i < len(events) && !events[i].Date.After(d); i++ {
			e := events[i]
			if e.Expected != nil {
				totE.Add(*e.Expected)
				if e.AccountID != nil {
					if a, ok := exp[*e.AccountID]; ok {
						a.Add(*e.Expected)
					}
				}
			}
			if e.Conservative != nil {
				totC.Add(*e.Conservative)
			}
			if e.Optimistic != nil {
				totO.Add(*e.Optimistic)
			}
			shown := e.Expected
			if shown == nil {
				shown = e.Conservative
			}
			if shown == nil {
				shown = e.Optimistic
			}
			if shown != nil {
				day.Events = append(day.Events, DayEvent{Description: e.Description, Amount: *shown, Confidence: e.Confidence, SourceID: e.SourceID,
					AccountID: e.AccountID, Kind: e.Kind, InExpected: e.Expected != nil})
			}
		}
		day.Expected, day.Conservative, day.Optimistic = totE.Money(cur), totC.Money(cur), totO.Money(cur)
		if first || cmpM(day.Expected, f.Lowest.Amount) < 0 {
			f.Lowest = Point{Date: day.Date, Amount: day.Expected}
		}
		if first || cmpM(day.Conservative, f.LowestConservative.Amount) < 0 {
			f.LowestConservative = Point{Date: day.Date, Amount: day.Conservative}
		}
		first = false
		for _, id := range ids {
			id := id
			track("e:"+id.String(), &id, "expected", exp[id].Money(cur), d)
		}
		track("e:total", nil, "expected", day.Expected, d)
		track("c:total", nil, "conservative", day.Conservative, d)
		if d.Equal(in.MonthEnd) {
			f.MonthEnd = day.Expected
		}
		if in.DailyOnly == nil || in.DailyOnly(d) {
			f.Days = append(f.Days, day)
		}
	}
	if in.MonthEnd.After(in.To) {
		f.MonthEnd = totE.Money(cur)
	}
	return f
}

// SafeToSpend = lowest conservative balance between from and until (inclusive) minus the reserve,
// floored at zero: spending that much today still keeps every committed and uncertain outflow
// covered under the conservative assumptions until `until`.
func SafeToSpend(f Forecast, until time.Time) money.Money {
	low := f.Start
	for _, d := range f.Days {
		if fin.MustDate(d.Date).After(until) {
			break
		}
		if cmpM(d.Conservative, low) < 0 {
			low = d.Conservative
		}
	}
	s, _ := low.Sub(f.Reserve)
	if s.Sign() < 0 {
		return fin.Zero(f.Currency)
	}
	return s
}

func cmpM(a, b money.Money) int {
	c, _ := a.Cmp(b)
	return c
}

func sameAcc(a, b *uuid.UUID) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
