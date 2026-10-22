package imports

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// synthTemplate maps testdata/synthetic-cp1250.csv.
const synthTemplate = `{"schemaVersion":1,"id":"synthetic-bank","name":"Synthetic bank","format":"csv","delimiter":";",
	"columns":{"postingDate":"Datum","description":"Opis","amount":"Iznos","currency":"Valuta","reference":"Referenca"},
	"dateFormat":"DD.MM.YYYY","number":{"decimalSeparator":",","thousandsSeparator":"."}}`

func TestSyntheticFormats(t *testing.T) {
	for _, c := range []struct {
		file, importer string
		pc             ParseContext
		n              int
	}{
		{"synthetic.camt053.xml", "generic-camt053", ParseContext{}, 2},
		{"synthetic.mt940", "generic-mt940", ParseContext{}, 3},
	} {
		b := fixture(t, c.file)
		imp := Detect(c.file, b, false)
		if imp == nil || imp.ID != c.importer {
			t.Fatalf("%s detected as %v", c.file, imp)
		}
		res, err := imp.parse(b, c.pc)
		if err != nil || len(res.Records) != c.n || len(res.Errors) != 0 {
			t.Fatalf("%s: %v %+v", c.file, err, res)
		}
	}
	// MT940 entry date crossing the year boundary, late-evening CAMT DtTm never shifts the date.
	res, _ := parseMT940(fixture(t, "synthetic.mt940"), ParseContext{})
	if r := res.Records[2]; r.PostingDate != "2025-01-02" || r.ValueDate != "2024-12-31" {
		t.Fatalf("mt940 year boundary %+v", r)
	}
	res, _ = parseCAMT("053")(fixture(t, "synthetic.camt053.xml"), ParseContext{})
	if r := res.Records[1]; r.PostingDate != "2025-01-10" {
		t.Fatalf("camt DtTm %+v", r)
	}
}

func TestCSVWindows1250(t *testing.T) {
	b := fixture(t, "synthetic-cp1250.csv")
	if enc := DetectEncoding(b); enc != "windows-1250" {
		t.Fatalf("encoding %s", enc)
	}
	tmpl, errs := ParseTemplate(json.RawMessage(synthTemplate))
	if errs != nil {
		t.Fatal(errs)
	}
	res, err := parseDelimited("csv")(b, ParseContext{Template: tmpl})
	if err != nil || len(res.Records) != 2 {
		t.Fatalf("%v %+v", err, res)
	}
	r := res.Records[0]
	if r.Description != "Kupovina ŠIŠ market ž" || r.Amount != "150.00" || r.Direction != "debit" || r.RowNumber != 2 || res.Encoding != "windows-1250" {
		t.Fatalf("%+v", r)
	}
	if s, _, _ := DecodeText([]byte{0xA9, 0xB9}, "auto"); s != "Šš" {
		t.Fatalf("latin2 detect: %q", s)
	}
}

func TestTemplateValidation(t *testing.T) {
	bad := map[string]string{
		"unknown field":        `{"schemaVersion":1,"id":"x-y","name":"n","format":"csv","columns":{"postingDate":"d","description":"x","amount":"a"},"dateFormat":"YYYY-MM-DD","number":{"decimalSeparator":"."},"script":"x"}`,
		"no amount":            `{"schemaVersion":1,"id":"x-y","name":"n","format":"csv","columns":{"postingDate":"d","description":"x"},"dateFormat":"YYYY-MM-DD","number":{"decimalSeparator":"."}}`,
		"bad date format":      `{"schemaVersion":1,"id":"x-y","name":"n","format":"csv","columns":{"postingDate":"d","description":"x","amount":"a"},"dateFormat":"%Y","number":{"decimalSeparator":"."}}`,
		"same separators":      `{"schemaVersion":1,"id":"x-y","name":"n","format":"csv","columns":{"postingDate":"d","description":"x","amount":"a"},"dateFormat":"YYYY-MM-DD","number":{"decimalSeparator":".","thousandsSeparator":"."}}`,
		"names w/o header":     `{"schemaVersion":1,"id":"x-y","name":"n","format":"csv","header":false,"columns":{"postingDate":"d","description":"x","amount":"a"},"dateFormat":"YYYY-MM-DD","number":{"decimalSeparator":"."}}`,
		"direction w/o values": `{"schemaVersion":1,"id":"x-y","name":"n","format":"csv","columns":{"postingDate":"d","description":"x","amount":"a","direction":"dc"},"dateFormat":"YYYY-MM-DD","number":{"decimalSeparator":"."}}`,
	}
	for name, raw := range bad {
		if _, errs := ParseTemplate(json.RawMessage(raw)); errs == nil {
			t.Errorf("%s: must be rejected", name)
		}
	}
	files, _ := filepath.Glob("../../../../packages/test-fixtures/imports/templates/*.json")
	for _, f := range files {
		raw, _ := os.ReadFile(f)
		if _, errs := ParseTemplate(raw); errs != nil {
			t.Errorf("shared template %s rejected: %v", f, errs)
		}
	}
}

func TestValues(t *testing.T) {
	for _, c := range []struct{ in, dec, thou, out string }{
		{"1.234,56", ",", ".", "1234.56"}, {"(5.00)", ".", ",", "-5.00"}, {"12,30-", ",", ".", "-12.30"}, {"1 500,00", ",", " ", "1500.00"},
		{"+7", ".", "", "7"}, {"-0.00", ".", "", "0.00"}, {"007.5", ".", "", "7.5"},
	} {
		if got, ok := parseAmountFmt(c.in, c.dec, c.thou); !ok || got != c.out {
			t.Errorf("parseAmountFmt(%q) = %q %v want %q", c.in, got, ok, c.out)
		}
	}
	for _, bad := range []string{"", "abc", "1e5", "1.2.3"} {
		if _, ok := parseAmountFmt(bad, ".", ","); ok {
			t.Errorf("%q must fail", bad)
		}
	}
	for _, c := range []struct{ in, f, out string }{
		{"05.03.2025", "DD.MM.YYYY", "2025-03-05"}, {"5.3.25", "D.M.YY", "2025-03-05"}, {"2025-01-31T23:59", "YYYY-MM-DD", "2025-01-31"},
		{"03/05/2025 10:22", "MM/DD/YYYY", "2025-03-05"},
	} {
		if got, ok := ParseTemplateDate(c.in, c.f); !ok || got != c.out {
			t.Errorf("date %q %s = %q", c.in, c.f, got)
		}
	}
	if _, ok := ParseTemplateDate("31.02.2025", "DD.MM.YYYY"); ok {
		t.Error("impossible date accepted")
	}
}

func zipOf(t *testing.T, files map[string][]byte) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, b := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write(b)
	}
	_ = zw.Close()
	return buf.Bytes()
}

func TestZipLimits(t *testing.T) {
	stmt := fixture(t, "synthetic.mt940")
	name, b, err := unwrapZip("s.zip", zipOf(t, map[string][]byte{"dir/stmt.sta": stmt}), 1<<20)
	if err != nil || name != "stmt.sta" || !bytes.Equal(b, stmt) {
		t.Fatalf("unwrap: %v %s", err, name)
	}
	bomb := zipOf(t, map[string][]byte{"a.csv": bytes.Repeat([]byte("0"), 5<<20)})
	if _, _, err := unwrapZip("b.zip", bomb, 1<<20); err == nil {
		t.Fatal("oversize content must be rejected")
	}
	if _, _, err := unwrapZip("b.zip", bomb, 50<<20); err == nil {
		t.Fatal("high compression ratio must be rejected")
	}
	if _, _, err := unwrapZip("m.zip", zipOf(t, map[string][]byte{"a.sta": stmt, "b.sta": stmt}), 1<<20); err == nil {
		t.Fatal("multi-file zip must be rejected")
	}
	if _, _, err := unwrapZip("t.zip", zipOf(t, map[string][]byte{"../evil.sta": stmt}), 1<<20); err == nil {
		t.Fatal("path traversal must be rejected")
	}
}

func TestXMLEntityAttacks(t *testing.T) {
	xxe := []byte(`<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><Document><BkToCstmrStmt><Stmt><Id>&x;</Id></Stmt></BkToCstmrStmt></Document>`)
	if _, err := parseCAMT("053")(xxe, ParseContext{}); err == nil {
		t.Fatal("DOCTYPE must be rejected")
	}
}

func TestMarkupNestingBomb(t *testing.T) {
	deep := "<OFX>" + strings.Repeat("<A>", 100000) + "x"
	if root := parseMarkup(deep); root == nil {
		t.Fatal("nil root")
	}
}

func TestFingerprint(t *testing.T) {
	if canonicalAmount("150.00", "debit") != "-150" || canonicalAmount("0.00", "debit") != "0" || canonicalAmount("007", "credit") != "7" {
		t.Fatal("canonicalAmount")
	}
	if canonicalRef(" nonref ") != "" || canonicalRef("ab 12") != "AB12" {
		t.Fatal("canonicalRef")
	}
	if canonicalDesc("Kupovina, MARKET ﬁ!") != "kupovinamarketfi" {
		t.Fatal(canonicalDesc("Kupovina, MARKET ﬁ!"))
	}
	a := Record{PostingDate: "2025-01-03", Direction: "debit", Amount: "150.00", Currency: "BAM", Description: "Kupovina, Market!"}
	b := a
	b.Description, b.Amount = "KUPOVINA market", "150"
	fps := Fingerprints([]Record{a, b})
	if fps[0] == fps[1] || Fingerprints([]Record{b})[0] != fps[0] {
		t.Fatal("ordinal / canonical equality")
	}
	other := a
	other.AccountRef = "OTHER"
	if Fingerprints([]Record{a, other})[1] != fps[0] {
		t.Fatal("ordinals are per accountRef")
	}
}

// Shared vectors with the TS SDK (docs/importing/fingerprint.md).
func TestFingerprintVectors(t *testing.T) {
	b, err := os.ReadFile("../../../../packages/test-fixtures/imports/fingerprint.json")
	if err != nil {
		t.Fatal(err)
	}
	var vec []struct {
		Name     string `json:"name"`
		Input    Record `json:"input"`
		Ordinal  int    `json:"ordinal"`
		Payload  string `json:"payload"`
		Expected string `json:"expected"`
	}
	if err := json.Unmarshal(b, &vec); err != nil || len(vec) == 0 {
		t.Fatalf("fingerprint.json: %v", err)
	}
	for _, v := range vec {
		key := fingerprintKey(v.Input)
		if p := strings.Join(key, "\x1f") + "\x1f" + itoa(v.Ordinal); p != v.Payload {
			t.Errorf("%s: payload %q want %q", v.Name, p, v.Payload)
		}
		if got := fingerprintOf(key, v.Ordinal); got != v.Expected {
			t.Errorf("%s: %s want %s", v.Name, got, v.Expected)
		}
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

// Shared merchant-template vectors with the TS SDK (merchantMatcher): whole-word matching, names under
// 3 letters/digits ignored, longest name first counted in runes.
func TestMerchantTemplateVectors(t *testing.T) {
	b, err := os.ReadFile("../../../../packages/test-fixtures/imports/merchant-templates.json")
	if err != nil {
		t.Fatal(err)
	}
	var vec struct {
		Merchants []struct {
			ID      uuid.UUID `json:"id"`
			Name    string    `json:"name"`
			Aliases []string  `json:"aliases"`
		} `json:"merchants"`
		Cases []struct {
			Description string     `json:"description"`
			MerchantID  *uuid.UUID `json:"merchantId"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &vec); err != nil || len(vec.Cases) == 0 {
		t.Fatalf("merchant-templates.json: %v", err)
	}
	var ms []merchantTemplate
	for _, m := range vec.Merchants {
		for _, n := range append([]string{m.Name}, m.Aliases...) {
			ms = append(ms, merchantTemplate{id: m.ID, name: n})
		}
	}
	s := &suggestions{byDesc: map[string]uuid.UUID{}, merchants: prepareMerchants(ms)}
	for _, c := range vec.Cases {
		got := s.suggest(c.Description).MerchantID
		if (got == nil) != (c.MerchantID == nil) || got != nil && *got != *c.MerchantID {
			t.Errorf("%q: got %v want %v", c.Description, got, c.MerchantID)
		}
	}
}
