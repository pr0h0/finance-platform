package money

import (
	"encoding/json"
	"math/big"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestJSONRoundTrip(t *testing.T) {
	m := MustParse("150", "BAM")
	b, _ := json.Marshal(m)
	if string(b) != `{"amount":"150.00","currency":"BAM"}` {
		t.Fatalf("got %s", b)
	}
	var back Money
	if err := json.Unmarshal(b, &back); err != nil || back.Amount() != "150.00" {
		t.Fatalf("unmarshal: %v %v", back, err)
	}
	if err := json.Unmarshal([]byte(`{"amount":"1.005","currency":"EUR"}`), &back); err == nil {
		t.Fatal("expected scale error")
	}
}

func TestFromNumeric(t *testing.T) {
	// NUMERIC(30,10) value 95.4000000000 => Int=954000000000 Exp=-10
	n := pgtype.Numeric{Int: big.NewInt(954000000000), Exp: -10, Valid: true}
	m, err := FromNumeric(n, "BAM")
	if err != nil || m.Amount() != "95.40" {
		t.Fatalf("got %v %v", m, err)
	}
	if _, err := FromNumeric(pgtype.Numeric{Int: big.NewInt(9541), Exp: -3, Valid: true}, "BAM"); err == nil {
		t.Fatal("expected error for 9.541 BAM")
	}
	if back, _ := FromNumeric(m.Numeric(), "BAM"); back.Amount() != "95.40" {
		t.Fatal("numeric round trip")
	}
}

func TestCurrencyMismatch(t *testing.T) {
	if _, err := MustParse("1", "EUR").Add(MustParse("1", "BAM")); err == nil {
		t.Fatal("expected mismatch")
	}
}
