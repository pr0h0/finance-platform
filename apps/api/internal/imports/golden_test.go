package imports

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// TestGoldenParity runs the Go parsers on the shared fixtures (packages/test-fixtures/imports) and
// compares them with what the TS importers produced (testdata/golden, regenerate with
// scripts/bun.sh run apps/api/internal/imports/testdata/golden/generate.ts). The fp1 fingerprints must
// be identical so a file imported through the web client and through the server deduplicates.
func TestGoldenParity(t *testing.T) {
	files, _ := filepath.Glob("testdata/golden/*.json")
	if len(files) == 0 {
		t.Fatal("no goldens")
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var g struct {
			Case struct {
				File, Importer, Template, Currency string
			} `json:"case"`
			Result struct {
				Result
				Fatal string `json:"fatal"`
			} `json:"result"`
		}
		if err := json.Unmarshal(b, &g); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		t.Run(filepath.Base(f), func(t *testing.T) {
			imp := findImporter(g.Case.Importer)
			if imp == nil {
				t.Fatalf("no Go importer %s", g.Case.Importer)
			}
			data, err := os.ReadFile("../../../../packages/test-fixtures/imports/" + g.Case.File)
			if err != nil {
				t.Fatal(err)
			}
			pc := ParseContext{AccountCurrency: g.Case.Currency}
			if g.Case.Template != "" {
				raw, _ := os.ReadFile("../../../../packages/test-fixtures/imports/templates/" + g.Case.Template)
				tmpl, errs := ParseTemplate(raw)
				if errs != nil {
					t.Fatalf("template: %v", errs)
				}
				pc.Template = tmpl
			}
			got, err := imp.parse(data, pc)
			if g.Result.Fatal != "" {
				if err == nil {
					t.Fatalf("TS failed (%s) but Go parsed", g.Result.Fatal)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := g.Result.Result
			if len(got.Records) != len(want.Records) {
				t.Fatalf("records: got %d want %d\n got=%+v", len(got.Records), len(want.Records), got.Records)
			}
			for i, w := range want.Records {
				r := got.Records[i]
				if r.PostingDate != w.PostingDate || r.Direction != w.Direction || r.Amount != w.Amount || r.Currency != w.Currency ||
					r.Fingerprint != w.Fingerprint || r.Description != w.Description || r.BankReference != w.BankReference ||
					r.ValueDate != w.ValueDate || r.RunningBalance != w.RunningBalance || r.AccountRef != w.AccountRef {
					t.Errorf("record %d:\n got  %s %s %s %s ref=%q desc=%q vd=%s rb=%s acct=%s %s\n want %s %s %s %s ref=%q desc=%q vd=%s rb=%s acct=%s %s", i,
						r.PostingDate, r.Direction, r.Amount, r.Currency, r.BankReference, r.Description, r.ValueDate, r.RunningBalance, r.AccountRef, r.Fingerprint,
						w.PostingDate, w.Direction, w.Amount, w.Currency, w.BankReference, w.Description, w.ValueDate, w.RunningBalance, w.AccountRef, w.Fingerprint)
				}
			}
			codes := func(is []Issue) string {
				var c []string
				for _, i := range is {
					c = append(c, i.Code)
				}
				sort.Strings(c)
				return strings.Join(c, ",")
			}
			if codes(got.Errors) != codes(want.Errors) {
				t.Errorf("errors: got %s want %s", codes(got.Errors), codes(want.Errors))
			}
			if len(got.Statements) != len(want.Statements) {
				t.Fatalf("statements: got %+v want %+v", got.Statements, want.Statements)
			}
			for i, w := range want.Statements {
				s := got.Statements[i]
				if s.OpeningBalance != w.OpeningBalance || s.ClosingBalance != w.ClosingBalance || s.PeriodStart != w.PeriodStart ||
					s.PeriodEnd != w.PeriodEnd || s.Currency != w.Currency || s.AccountRef != w.AccountRef {
					t.Errorf("statement %d: got %+v want %+v", i, s, w)
				}
			}
		})
	}
}
