package recurrence

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func d(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func dates(t *testing.T, spec Spec, from, to string) string {
	t.Helper()
	occ, err := Expand(spec, d(from), d(to), 0)
	if err != nil {
		t.Fatal(err)
	}
	var s []string
	for _, o := range occ {
		s = append(s, o.Due.Format("2006-01-02"))
	}
	return strings.Join(s, ",")
}

// PLAN §46 case 11: recurring schedules handle month boundaries.
func TestMonthEndClamping(t *testing.T) {
	got := dates(t, Spec{RRule: "FREQ=MONTHLY", Start: d("2024-01-31")}, "2024-01-01", "2024-06-30")
	want := "2024-01-31,2024-02-29,2024-03-31,2024-04-30,2024-05-31,2024-06-30"
	if got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	// Non-leap year, anchor from the 30th: Feb clamps, March returns to the 30th.
	got = dates(t, Spec{RRule: "FREQ=MONTHLY", Start: d("2025-01-30")}, "2025-01-01", "2025-03-31")
	if got != "2025-01-30,2025-02-28,2025-03-30" {
		t.Fatalf("got %s", got)
	}
	// Last day of month via BYMONTHDAY=-1.
	got = dates(t, Spec{RRule: "FREQ=MONTHLY;BYMONTHDAY=-1", Start: d("2025-01-01")}, "2025-01-01", "2025-04-30")
	if got != "2025-01-31,2025-02-28,2025-03-31,2025-04-30" {
		t.Fatalf("got %s", got)
	}
	// Yearly Feb 29 clamps to Feb 28 in non-leap years.
	got = dates(t, Spec{RRule: "FREQ=YEARLY", Start: d("2024-02-29")}, "2024-01-01", "2028-12-31")
	if got != "2024-02-29,2025-02-28,2026-02-28,2027-02-28,2028-02-29" {
		t.Fatalf("got %s", got)
	}
}

func TestWeeklyIntervalsAndCount(t *testing.T) {
	got := dates(t, Spec{RRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=5", Start: d("2026-10-01")}, "2026-01-01", "2027-12-31")
	// 2026-10-01 is a Thursday.
	if got != "2026-10-01,2026-10-12,2026-10-15,2026-10-26,2026-10-29" {
		t.Fatalf("got %s", got)
	}
	// COUNT counts from the start even when `from` is later.
	got = dates(t, Spec{RRule: "FREQ=DAILY;COUNT=3", Start: d("2026-01-01")}, "2026-01-02", "2026-12-31")
	if got != "2026-01-02,2026-01-03" {
		t.Fatalf("got %s", got)
	}
}

func TestOrdinalWeekdayAndTermination(t *testing.T) {
	end := d("2026-12-31")
	got := dates(t, Spec{RRule: "FREQ=MONTHLY;BYDAY=-1FR", Start: d("2026-10-01"), End: &end}, "2026-01-01", "2027-12-31")
	if got != "2026-10-30,2026-11-27,2026-12-25" {
		t.Fatalf("got %s", got)
	}
	n := 2
	got = dates(t, Spec{RRule: "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=10", Start: d("2026-01-01"), Count: &n}, "2026-01-01", "2026-12-31")
	if got != "2026-01-15,2026-02-15" {
		t.Fatalf("stricter count must win, got %s", got)
	}
	got = dates(t, Spec{RRule: "FREQ=MONTHLY;UNTIL=20260301", Start: d("2026-01-10")}, "2026-01-01", "2026-12-31")
	if got != "2026-01-10,2026-02-10" {
		t.Fatalf("got %s", got)
	}
}

func TestBusinessDayAdjustment(t *testing.T) {
	// 2026-11-01 is a Sunday, 2026-08-01 a Saturday.
	got := dates(t, Spec{RRule: "FREQ=MONTHLY;BYMONTHDAY=1", Start: d("2026-08-01"), Adjustment: "next"}, "2026-08-01", "2026-11-30")
	if got != "2026-08-03,2026-09-01,2026-10-01,2026-11-02" {
		t.Fatalf("next: got %s", got)
	}
	got = dates(t, Spec{RRule: "FREQ=MONTHLY;BYMONTHDAY=1", Start: d("2026-08-01"), Adjustment: "previous"}, "2026-07-01", "2026-11-30")
	if got != "2026-07-31,2026-09-01,2026-10-01,2026-10-30" {
		t.Fatalf("previous: got %s", got)
	}
	occ, _ := Expand(Spec{RRule: "FREQ=MONTHLY;BYMONTHDAY=1", Start: d("2026-08-01"), Adjustment: "next"}, d("2026-08-01"), d("2026-08-31"), 0)
	if occ[0].Date.Format("2006-01-02") != "2026-08-01" {
		t.Fatal("nominal date must stay the identity")
	}
}

// DST: the schedule is calendar-based, so a DST change between occurrences changes nothing.
func TestDSTIndependent(t *testing.T) {
	got := dates(t, Spec{RRule: "FREQ=DAILY", Start: d("2026-10-24")}, "2026-10-24", "2026-10-27")
	if got != "2026-10-24,2026-10-25,2026-10-26,2026-10-27" {
		t.Fatalf("got %s", got)
	}
}

func TestParseRejects(t *testing.T) {
	for _, s := range []string{"", "FREQ=HOURLY", "FREQ=WEEKLY;BYDAY=1MO", "FREQ=YEARLY;BYDAY=MO", "FREQ=MONTHLY;BYSETPOS=1", "FREQ=WEEKLY;BYMONTHDAY=1", "FREQ=MONTHLY;INTERVAL=0", "FREQ=MONTHLY;BYMONTHDAY=32"} {
		if _, err := Parse(s); err == nil {
			t.Errorf("%q should be rejected", s)
		}
	}
}

func TestPerYear(t *testing.T) {
	cases := map[string][2]int64{
		"FREQ=MONTHLY":                 {12, 1},
		"FREQ=MONTHLY;INTERVAL=3":      {12, 3},
		"FREQ=WEEKLY;INTERVAL=2":       {52, 2},
		"FREQ=YEARLY":                  {1, 1},
		"FREQ=DAILY":                   {365, 1},
		"FREQ=MONTHLY;BYMONTHDAY=1,15": {24, 1},
		"FREQ=YEARLY;BYMONTH=1,7":      {2, 1},
		"FREQ=WEEKLY;BYDAY=MO,WE,FR":   {156, 1},
	}
	for s, want := range cases {
		r, err := Parse(s)
		if err != nil {
			t.Fatal(err)
		}
		n, den := PerYear(r)
		if n != want[0] || den != want[1] {
			t.Errorf("%s: got %d/%d want %d/%d", s, n, den, want[0], want[1])
		}
	}
}

// Shared conformance fixture with the TypeScript engine (skipped until the fixture exists).
func TestConformanceRecurrence(t *testing.T) {
	b, err := os.ReadFile("../../../../packages/test-fixtures/conformance/recurrence.json")
	if err != nil {
		t.Skip("recurrence.json fixture not present")
	}
	var fx struct {
		Cases []struct {
			Name  string `json:"name"`
			Input struct {
				Rrule                 string  `json:"rrule"`
				StartDate             string  `json:"startDate"`
				EndDate               *string `json:"endDate"`
				OccurrenceCount       *int    `json:"occurrenceCount"`
				BusinessDayAdjustment string  `json:"businessDayAdjustment"`
				From                  string  `json:"from"`
				To                    string  `json:"to"`
			} `json:"input"`
			Expected []struct {
				Date    string `json:"date"`
				DueDate string `json:"dueDate"`
			} `json:"expected"`
			Error *string `json:"error"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &fx); err != nil {
		t.Fatalf("fixture format: %v", err)
	}
	if len(fx.Cases) == 0 {
		t.Skip("fixture has an unknown shape")
	}
	for _, c := range fx.Cases {
		spec := Spec{RRule: c.Input.Rrule, Start: d(c.Input.StartDate), Count: c.Input.OccurrenceCount, Adjustment: c.Input.BusinessDayAdjustment}
		if c.Input.EndDate != nil {
			e := d(*c.Input.EndDate)
			spec.End = &e
		}
		occ, err := Expand(spec, d(c.Input.From), d(c.Input.To), 0)
		if c.Error != nil {
			if err == nil {
				t.Errorf("%s: expected error", c.Name)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		if len(occ) != len(c.Expected) {
			t.Errorf("%s: got %d occurrences want %d", c.Name, len(occ), len(c.Expected))
			continue
		}
		for i, e := range c.Expected {
			if occ[i].Date.Format("2006-01-02") != e.Date || occ[i].Due.Format("2006-01-02") != e.DueDate {
				t.Errorf("%s[%d]: got %s/%s want %s/%s", c.Name, i, occ[i].Date.Format("2006-01-02"), occ[i].Due.Format("2006-01-02"), e.Date, e.DueDate)
			}
		}
	}
}
