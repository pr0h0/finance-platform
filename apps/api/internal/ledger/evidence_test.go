package ledger

import (
	"testing"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

func TestEvidenceKept(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	p := func(acc uuid.UUID, amt string) Posting { return Posting{AccountID: acc, Amount: money.MustParse(amt, "BAM")} }
	exp := &Transaction{Kind: "expense", Postings: []Posting{p(a, "-10.00")}}
	cases := []struct {
		name  string
		after *Transaction
		want  bool
	}{
		{"unchanged", &Transaction{Kind: "expense", Postings: []Posting{p(a, "-10.00")}}, true},
		{"amount changed", &Transaction{Kind: "expense", Postings: []Posting{p(a, "-11.00")}}, false},
		{"kind changed", &Transaction{Kind: "income", Postings: []Posting{p(a, "-10.00")}}, false},
		{"linked into transfer", &Transaction{Kind: "transfer", Postings: []Posting{p(a, "-10.00"), p(b, "10.00")}}, true},
		{"transfer without own posting", &Transaction{Kind: "transfer", Postings: []Posting{p(b, "-10.00"), p(a, "10.00")}}, false},
	}
	for _, c := range cases {
		if got := evidenceKept(exp, c.after); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	tr := &Transaction{Kind: "transfer", Postings: []Posting{p(a, "-10.00"), p(b, "10.00")}}
	if !evidenceKept(tr, exp) {
		t.Error("undoing a link back to the imported expense must be allowed")
	}
}
