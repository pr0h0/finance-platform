package money

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const fixtureDir = "../../../../packages/test-fixtures/conformance"

func load(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtureDir, name+".json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("parse fixture %s: %v", name, err)
	}
}

type wire struct {
	Amount   string `json:"amount"`
	Currency string `json:"currency"`
}

func TestConformanceScales(t *testing.T) {
	var cases []struct {
		Currency string `json:"currency"`
		Scale    *int   `json:"scale"`
	}
	load(t, "scales", &cases)
	for _, c := range cases {
		s, ok := Scale(c.Currency)
		if (c.Scale == nil) == ok || (ok && s != *c.Scale) {
			t.Errorf("%s: got %d,%v", c.Currency, s, ok)
		}
	}
}

func TestConformanceParse(t *testing.T) {
	var cases []struct {
		Amount, Currency, Expected string
		Error                      bool
	}
	load(t, "money_parse", &cases)
	for _, c := range cases {
		m, err := Parse(c.Amount, c.Currency)
		if c.Error {
			if err == nil {
				t.Errorf("%q %s: expected error, got %s", c.Amount, c.Currency, m.Amount())
			}
			continue
		}
		if err != nil || m.Amount() != c.Expected {
			t.Errorf("%q %s: got %v %v want %s", c.Amount, c.Currency, m, err, c.Expected)
		}
	}
}

func TestConformanceRounding(t *testing.T) {
	var cases []struct {
		Value    string
		Scale    int
		Mode     RoundingMode
		Expected string
	}
	load(t, "rounding", &cases)
	for _, c := range cases {
		got, err := RoundDecimal(c.Value, c.Scale, c.Mode)
		if err != nil || got != c.Expected {
			t.Errorf("%s %s/%d: got %s %v want %s", c.Value, c.Mode, c.Scale, got, err, c.Expected)
		}
	}
}

func TestConformanceFX(t *testing.T) {
	var cases []struct {
		Amount, From, To, Rate, Expected string
		Inverse                          bool
		Mode                             RoundingMode
	}
	load(t, "fx", &cases)
	for _, c := range cases {
		m := MustParse(c.Amount, c.From)
		var r Money
		var err error
		if c.Inverse {
			r, err = m.ConvertInverse(c.To, c.Rate, c.Mode)
		} else {
			r, err = m.Convert(c.To, c.Rate, c.Mode)
		}
		if err != nil || r.Amount() != c.Expected || r.Currency() != c.To {
			t.Errorf("%s %s->%s @%s: got %v %v want %s", c.Amount, c.From, c.To, c.Rate, r, err, c.Expected)
		}
	}
}

func TestConformanceAllocation(t *testing.T) {
	var cases []struct {
		Amount, Currency  string
		Weights, Expected []string
	}
	load(t, "allocation", &cases)
	for _, c := range cases {
		parts, err := MustParse(c.Amount, c.Currency).Allocate(c.Weights)
		if err != nil || len(parts) != len(c.Expected) {
			t.Fatalf("%s: %v", c.Amount, err)
		}
		for i, p := range parts {
			if p.Amount() != c.Expected[i] {
				t.Errorf("%s %v: part %d got %s want %s", c.Amount, c.Weights, i, p.Amount(), c.Expected[i])
			}
		}
	}
}

func TestConformanceSplits(t *testing.T) {
	var cases []struct {
		Total  wire
		Splits []wire
		Valid  bool
	}
	load(t, "splits", &cases)
	for i, c := range cases {
		var ss []Money
		for _, s := range c.Splits {
			ss = append(ss, MustParse(s.Amount, s.Currency))
		}
		if got := SplitsBalance(MustParse(c.Total.Amount, c.Total.Currency), ss); got != c.Valid {
			t.Errorf("case %d: got %v want %v", i, got, c.Valid)
		}
	}
}

func TestConformanceBalance(t *testing.T) {
	type line struct {
		AccountID string `json:"accountId"`
		wire
	}
	var cases []struct {
		Name     string
		Postings []line
		Expected []line
	}
	load(t, "balance", &cases)
	for _, c := range cases {
		var ps []Posting
		for _, p := range c.Postings {
			ps = append(ps, Posting{p.AccountID, MustParse(p.Amount, p.Currency)})
		}
		got := Balances(ps)
		if len(got) != len(c.Expected) {
			t.Fatalf("%s: got %d balances want %d", c.Name, len(got), len(c.Expected))
		}
		for i, e := range c.Expected {
			if got[i].AccountID != e.AccountID || got[i].Amount.Amount() != e.Amount || got[i].Amount.Currency() != e.Currency {
				t.Errorf("%s[%d]: got %s %v want %+v", c.Name, i, got[i].AccountID, got[i].Amount, e)
			}
		}
	}
}
