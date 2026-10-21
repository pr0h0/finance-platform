package exchangerates

import (
	"testing"

	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

func TestRateValueAndConvert(t *testing.T) {
	r := Rate{From: "BAM", To: "EUR", Stored: "1.95583", Inverse: true}
	if v := r.Value(); v != "0.511291881196218485" {
		t.Fatalf("inverse value %s", v)
	}
	got, err := r.Convert(money.MustParse("1.96", "BAM"), money.HalfUp)
	if err != nil || got.Amount() != "1.00" {
		t.Fatalf("inverse convert %v %v", got, err)
	}
	if _, err := r.Convert(money.MustParse("1.00", "USD"), money.HalfUp); err == nil {
		t.Fatal("currency mismatch accepted")
	}
	for _, bad := range []string{"0", "-1.2", "1e5", "1/3", "abc", "+1", "1.0000000000000000001"} {
		if ValidRate(bad) == nil {
			t.Errorf("ValidRate(%q) accepted", bad)
		}
	}
	if ValidRate("1.95583") != nil {
		t.Fatal("valid rate rejected")
	}
}
