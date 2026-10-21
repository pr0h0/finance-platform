package recurrence

// Recurrence expansion: an RFC 5545 RRULE subset over local calendar dates. Mirrors
// packages/finance-engine/src/recurrence.ts rule for rule (shared fixture:
// packages/test-fixtures/conformance/recurrence.json).
//
// Supported parts: FREQ (DAILY|WEEKLY|MONTHLY|YEARLY), INTERVAL, COUNT, UNTIL (date part),
// BYDAY (WEEKLY: MO..SU; MONTHLY or YEARLY+BYMONTH: optional ordinal, e.g. 1MO, -1FR),
// BYMONTHDAY (1..31, -1..-31), BYMONTH (1..12), WKST=MO. Anything else is rejected.
//
// Rules (deliberate deviations from RFC 5545 are marked *):
//   - Occurrences are rule dates >= startDate; startDate itself only when it matches the rule.
//   - * A month day past the month's end clamps to the last day (Jan 31 monthly -> Feb 28/29, Mar 31);
//     always computed from the anchor, never from the previous occurrence. Clamped duplicates collapse.
//   - Negative BYMONTHDAY counts from the end (-1 = last day); out of range -> skipped.
//   - An ordinal BYDAY that does not exist in a month (5MO) is skipped (RFC behaviour).
//   - BYMONTHDAY and BYDAY together intersect (RFC). DAILY treats BYDAY/BYMONTHDAY/BYMONTH as filters.
//   - COUNT / occurrenceCount and UNTIL / endDate both apply (the stricter wins) to nominal dates.
//   - Business-day adjustment moves Saturday/Sunday to Friday ("previous") or Monday ("next") AFTER
//     expansion; the nominal date stays the occurrence identity. No holiday calendar.
//   - Timezone and DST never matter: everything is a calendar date. The schedule's timezone only
//     decides what "today" is for reminders.

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type ByDay struct {
	Weekday int // 1 = MO ... 7 = SU
	Ordinal int // 0 = every
}

type Rule struct {
	Freq       string
	Interval   int
	Count      int // 0 = unlimited
	Until      *time.Time
	ByDay      []ByDay
	ByMonthDay []int
	ByMonth    []int
}

var weekdays = []string{"MO", "TU", "WE", "TH", "FR", "SA", "SU"}

var (
	untilRE = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$`)
	byDayRE = regexp.MustCompile(`^(?i)([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$`)
	intRE   = regexp.MustCompile(`^[+-]?\d+$`)
)

func intList(v string, lo, hi int, part string) ([]int, error) {
	var out []int
	for _, x := range strings.Split(v, ",") {
		if !intRE.MatchString(x) {
			return nil, fmt.Errorf("rrule: invalid %s value %s", part, x)
		}
		n, _ := strconv.Atoi(x)
		a := n
		if a < 0 {
			a = -a
		}
		if n == 0 || a < lo || a > hi {
			return nil, fmt.Errorf("rrule: %s out of range: %s", part, x)
		}
		out = append(out, n)
	}
	return out, nil
}

// Parse validates an RRULE (optionally prefixed "RRULE:").
func Parse(input string) (Rule, error) {
	s := strings.TrimSpace(input)
	if len(s) >= 6 && strings.EqualFold(s[:6], "RRULE:") {
		s = s[6:]
	}
	r := Rule{Freq: "", Interval: 1}
	for _, part := range strings.Split(s, ";") {
		if part == "" {
			continue
		}
		k, v, ok := strings.Cut(part, "=")
		if !ok || v == "" {
			return r, fmt.Errorf("rrule: malformed part %s", part)
		}
		var err error
		switch strings.ToUpper(k) {
		case "FREQ":
			f := strings.ToUpper(v)
			if f != "DAILY" && f != "WEEKLY" && f != "MONTHLY" && f != "YEARLY" {
				return r, fmt.Errorf("rrule: unsupported FREQ %s", v)
			}
			r.Freq = f
		case "INTERVAL":
			var n []int
			if n, err = intList(v, 1, 10_000, "INTERVAL"); err == nil && n[0] < 1 {
				err = errors.New("rrule: INTERVAL must be positive")
			}
			if err == nil {
				r.Interval = n[0]
			}
		case "COUNT":
			var n []int
			if n, err = intList(v, 1, 100_000, "COUNT"); err == nil && n[0] < 1 {
				err = errors.New("rrule: COUNT must be positive")
			}
			if err == nil {
				r.Count = n[0]
			}
		case "UNTIL":
			m := untilRE.FindStringSubmatch(v)
			if m == nil {
				return r, fmt.Errorf("rrule: invalid UNTIL %s", v)
			}
			t, perr := time.Parse("20060102", m[1]+m[2]+m[3])
			if perr != nil {
				return r, fmt.Errorf("rrule: invalid UNTIL %s", v)
			}
			r.Until = &t
		case "BYDAY":
			r.ByDay = nil
			for _, x := range strings.Split(v, ",") {
				m := byDayRE.FindStringSubmatch(x)
				if m == nil {
					return r, fmt.Errorf("rrule: invalid BYDAY %s", x)
				}
				ord := 0
				if m[1] != "" {
					ord, _ = strconv.Atoi(m[1])
					if ord == 0 || ord > 5 || ord < -5 {
						return r, fmt.Errorf("rrule: BYDAY ordinal out of range: %s", x)
					}
				}
				wd := 0
				for i, w := range weekdays {
					if strings.EqualFold(w, m[2]) {
						wd = i + 1
					}
				}
				r.ByDay = append(r.ByDay, ByDay{Weekday: wd, Ordinal: ord})
			}
		case "BYMONTHDAY":
			r.ByMonthDay, err = intList(v, 1, 31, "BYMONTHDAY")
		case "BYMONTH":
			if r.ByMonth, err = intList(v, 1, 12, "BYMONTH"); err == nil {
				for _, n := range r.ByMonth {
					if n < 0 {
						err = errors.New("rrule: BYMONTH must be positive")
					}
				}
			}
		case "WKST":
			if !strings.EqualFold(v, "MO") {
				err = errors.New("rrule: only WKST=MO is supported")
			}
		default:
			err = fmt.Errorf("rrule: unsupported part %s", k)
		}
		if err != nil {
			return r, err
		}
	}
	if r.Freq == "" {
		return r, errors.New("rrule: FREQ is required")
	}
	ordinals := false
	for _, b := range r.ByDay {
		ordinals = ordinals || b.Ordinal != 0
	}
	if ordinals && (r.Freq == "DAILY" || r.Freq == "WEEKLY") {
		return r, errors.New("rrule: BYDAY ordinals need FREQ=MONTHLY or YEARLY")
	}
	if r.Freq == "YEARLY" && len(r.ByDay) > 0 && len(r.ByMonth) == 0 {
		return r, errors.New("rrule: YEARLY BYDAY requires BYMONTH")
	}
	if r.Freq == "WEEKLY" && len(r.ByMonthDay) > 0 {
		return r, errors.New("rrule: BYMONTHDAY is not valid with FREQ=WEEKLY")
	}
	return r, nil
}

// Spec is a schedule: rule + anchor + termination + weekend handling.
type Spec struct {
	RRule      string
	Start      time.Time
	End        *time.Time
	Count      *int
	Adjustment string // none | previous | next
}

// Occurrence of a schedule.
type Occurrence struct {
	Index int       // 0-based position in the series (counts from the schedule start)
	Date  time.Time // nominal rule date: the occurrence identity
	Due   time.Time // after business-day adjustment
}

func date(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }
func daysIn(y int, m time.Month) int            { return date(y, m+1, 0).Day() }
func isoWeekday(t time.Time) int {
	if wd := int(t.Weekday()); wd != 0 {
		return wd
	}
	return 7
}

func contains(xs []int, v int) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

func monthDays(byMonthDay []int, dim int) []int {
	var out []int
	for _, n := range byMonthDay {
		if n > 0 {
			out = append(out, min(n, dim))
		} else if dim+n+1 >= 1 {
			out = append(out, dim+n+1)
		}
	}
	return out
}

// monthCandidates: candidate dates of one month (sorted, unique); defaultDay = anchor day.
func monthCandidates(r Rule, y int, m time.Month, defaultDay int) []time.Time {
	dim := daysIn(y, m)
	set := map[int]bool{}
	switch {
	case len(r.ByDay) > 0:
		firstWd := isoWeekday(date(y, m, 1))
		for _, b := range r.ByDay {
			first := 1 + ((b.Weekday-firstWd)%7+7)%7
			var all []int
			for d := first; d <= dim; d += 7 {
				all = append(all, d)
			}
			switch {
			case b.Ordinal == 0:
				for _, d := range all {
					set[d] = true
				}
			case b.Ordinal > 0 && b.Ordinal <= len(all):
				set[all[b.Ordinal-1]] = true
			case b.Ordinal < 0 && -b.Ordinal <= len(all):
				set[all[len(all)+b.Ordinal]] = true
			}
		}
		if len(r.ByMonthDay) > 0 {
			md := monthDays(r.ByMonthDay, dim)
			for d := range set {
				if !contains(md, d) {
					delete(set, d)
				}
			}
		}
	case len(r.ByMonthDay) > 0:
		for _, d := range monthDays(r.ByMonthDay, dim) {
			set[d] = true
		}
	default:
		set[min(defaultDay, dim)] = true
	}
	days := make([]int, 0, len(set))
	for d := range set {
		days = append(days, d)
	}
	sort.Ints(days)
	out := make([]time.Time, len(days))
	for i, d := range days {
		out[i] = date(y, m, d)
	}
	return out
}

// Adjust applies the weekend rule.
func Adjust(t time.Time, mode string) time.Time {
	wd := isoWeekday(t)
	if wd < 6 || mode == "" || mode == "none" {
		return t
	}
	if mode == "previous" {
		if wd == 6 {
			return t.AddDate(0, 0, -1)
		}
		return t.AddDate(0, 0, -2)
	}
	if wd == 6 {
		return t.AddDate(0, 0, 2)
	}
	return t.AddDate(0, 0, 1)
}

// Expand returns occurrences whose adjusted due date lies in [from, to] (inclusive), in order.
// COUNT is always counted from the schedule start. limit <= 0 means 100000.
func Expand(spec Spec, from, to time.Time, limit int) ([]Occurrence, error) {
	r, err := Parse(spec.RRule)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100_000
	}
	start := spec.Start
	end := spec.End
	if r.Until != nil && (end == nil || r.Until.Before(*end)) {
		end = r.Until
	}
	maxCount := math.MaxInt
	if r.Count > 0 {
		maxCount = r.Count
	}
	if spec.Count != nil && *spec.Count < maxCount {
		maxCount = *spec.Count
	}
	horizon := to.AddDate(0, 0, 3) // adjustment moves dates by at most 2 days
	lower := from.AddDate(0, 0, -3)
	var out []Occurrence
	emitted := 0
	weekStart := start.AddDate(0, 0, -(isoWeekday(start) - 1))

	for k := 0; ; k++ {
		var periodStart time.Time
		var cands []time.Time
		switch r.Freq {
		case "DAILY":
			periodStart = start.AddDate(0, 0, k*r.Interval)
			p := periodStart
			ok := (len(r.ByMonth) == 0 || contains(r.ByMonth, int(p.Month()))) &&
				(len(r.ByMonthDay) == 0 || contains(monthDays(r.ByMonthDay, daysIn(p.Year(), p.Month())), p.Day()))
			if ok && len(r.ByDay) > 0 {
				ok = false
				for _, b := range r.ByDay {
					ok = ok || b.Weekday == isoWeekday(p)
				}
			}
			if ok {
				cands = []time.Time{periodStart}
			}
		case "WEEKLY":
			periodStart = weekStart.AddDate(0, 0, 7*k*r.Interval)
			wds := []int{isoWeekday(start)}
			if len(r.ByDay) > 0 {
				wds = nil
				for _, b := range r.ByDay {
					if !contains(wds, b.Weekday) {
						wds = append(wds, b.Weekday)
					}
				}
				sort.Ints(wds)
			}
			for _, wd := range wds {
				d := periodStart.AddDate(0, 0, wd-1)
				if len(r.ByMonth) == 0 || contains(r.ByMonth, int(d.Month())) {
					cands = append(cands, d)
				}
			}
		case "MONTHLY":
			periodStart = date(start.Year(), start.Month()+time.Month(k*r.Interval), 1)
			if len(r.ByMonth) == 0 || contains(r.ByMonth, int(periodStart.Month())) {
				cands = monthCandidates(r, periodStart.Year(), periodStart.Month(), start.Day())
			}
		case "YEARLY":
			y := start.Year() + k*r.Interval
			periodStart = date(y, 1, 1)
			months := []int{int(start.Month())}
			if len(r.ByMonth) > 0 {
				months = nil
				for _, m := range r.ByMonth {
					if !contains(months, m) {
						months = append(months, m)
					}
				}
				sort.Ints(months)
			}
			for _, m := range months {
				cands = append(cands, monthCandidates(r, y, time.Month(m), start.Day())...)
			}
		}
		if periodStart.After(horizon) || (end != nil && periodStart.After(*end) && periodStart.After(start)) {
			break
		}
		for _, d := range cands {
			if d.Before(start) {
				continue
			}
			if (end != nil && d.After(*end)) || d.After(horizon) || emitted >= maxCount {
				return out, nil
			}
			idx := emitted
			emitted++
			if d.Before(lower) {
				continue
			}
			due := Adjust(d, spec.Adjustment)
			if !due.Before(from) && !due.After(to) {
				out = append(out, Occurrence{Index: idx, Date: d, Due: due})
				if len(out) >= limit {
					return out, nil
				}
			}
		}
	}
	return out, nil
}

// Next returns the first occurrence with due date >= from within maxYears.
func Next(spec Spec, from time.Time, maxYears int) (*Occurrence, error) {
	occ, err := Expand(spec, from, date(from.Year()+maxYears, from.Month(), 1), 1)
	if err != nil || len(occ) == 0 {
		return nil, err
	}
	return &occ[0], nil
}

// PerYear returns how many occurrences the rule produces per year as an exact fraction num/den,
// used for annualized/monthly equivalents. Daily uses 365 days per year, weekly 52 weeks
// (documented approximations); BYDAY/BYMONTHDAY/BYMONTH multiply per-period counts.
// Ordinal BYDAY in a monthly rule counts once per listed ordinal.
func PerYear(r Rule) (num, den int64) {
	n := int64(1)
	switch r.Freq {
	case "DAILY":
		days := int64(365)
		if len(r.ByDay) > 0 {
			days = 52 * int64(len(r.ByDay))
		}
		if len(r.ByMonth) > 0 {
			return days * int64(len(r.ByMonth)), 12 * int64(r.Interval)
		}
		return days, int64(r.Interval)
	case "WEEKLY":
		if len(r.ByDay) > 0 {
			n = int64(len(r.ByDay))
		}
		return 52 * n, int64(r.Interval)
	case "MONTHLY":
		switch {
		case len(r.ByMonthDay) > 0:
			n = int64(len(r.ByMonthDay))
		case len(r.ByDay) > 0:
			n = 0
			for _, b := range r.ByDay {
				if b.Ordinal == 0 {
					n += 4 // ~4.33 per month; documented floor approximation
				} else {
					n++
				}
			}
		}
		months := int64(12)
		if len(r.ByMonth) > 0 {
			months = int64(len(r.ByMonth))
		}
		return months * n, int64(r.Interval)
	case "YEARLY":
		if len(r.ByMonth) > 0 {
			n = int64(len(r.ByMonth))
		}
		if len(r.ByMonthDay) > 0 {
			n *= int64(len(r.ByMonthDay))
		}
		return n, int64(r.Interval)
	}
	return 0, 1
}
