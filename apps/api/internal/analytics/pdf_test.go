package analytics

import (
	"bytes"
	"compress/zlib"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

const unicodeSample = "čćđšž ČĆĐŠŽ € £ ¥ ₺ ₽ ₴ ₹ KM – „navodnici“ … Ђорђе"

func TestPDFFontsCoverAppCharacters(t *testing.T) {
	for _, f := range pdfFonts {
		if f.fallback == 0 {
			t.Fatalf("%s: no U+FFFD glyph", f.name)
		}
		for _, r := range unicodeSample {
			if _, ok := f.cmap[r]; !ok {
				t.Errorf("%s: no glyph for %q", f.name, r)
			}
		}
	}
}

// TestPDFUnicodeRoundTrip renders Bosnian text and currency symbols and reads them back through
// the ToUnicode maps (what PDF viewers use for copy/search). With poppler's pdftotext on PATH it
// also checks a real extractor.
func TestPDFUnicodeRoundTrip(t *testing.T) {
	m := func(a string) money.Money { return money.MustParse(a, "BAM") }
	rep := Report{Kind: "monthly", From: "2026-10-01", To: "2026-10-31", Currency: "BAM", GeneratedAt: "2026-11-01T00:00:00Z",
		Income: m("1234.56"), Expenses: m("-0.05"), Net: m("1234.51"), Complete: true,
		ByCategory:   []fin.Row{{Label: "Hrana i piće " + unicodeSample, Amount: m("12.00")}},
		TopMerchants: []fin.Row{{Label: "Pekara Đurđević 😀", Amount: m("3.50")}}}
	pdf := rep.PDF()
	got := extractPDFText(t, pdf)
	for _, want := range []string{"Hrana i piće " + unicodeSample, "Pekara Đurđević �", "Spending by category", "Income: 1234.56"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in extracted text:\n%s", want, got)
		}
	}
	if _, err := exec.LookPath("pdftotext"); err != nil {
		t.Log("pdftotext not installed; skipped external extractor check")
		return
	}
	path := filepath.Join(t.TempDir(), "r.pdf")
	if err := os.WriteFile(path, pdf, 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("pdftotext", "-enc", "UTF-8", path, "-").CombinedOutput()
	if err != nil || !strings.Contains(string(out), unicodeSample) {
		t.Fatalf("pdftotext: %v\n%s", err, out)
	}
}

// extractPDFText decodes our writer's output: hex glyph strings per page, mapped through the
// ToUnicode CMap of the font selected by the preceding Tf.
func extractPDFText(t *testing.T, pdf []byte) string {
	t.Helper()
	obj := regexp.MustCompile(`(?s)(\d+) 0 obj\n(.*?)\nendobj`)
	streams := map[string]string{}
	dicts := map[string]string{}
	for _, mm := range obj.FindAllSubmatch(pdf, -1) {
		id, body := string(mm[1]), mm[2]
		dicts[id] = string(body)
		if i := bytes.Index(body, []byte("\nstream\n")); i >= 0 {
			data := body[i+8 : bytes.LastIndex(body, []byte("\nendstream"))]
			if bytes.Contains(body[:i], []byte("FlateDecode")) {
				r, err := zlib.NewReader(bytes.NewReader(data))
				if err != nil {
					t.Fatal(err)
				}
				data, _ = io.ReadAll(r)
			}
			streams[id] = string(data)
		}
	}
	ref := func(dict, key string) string {
		mm := regexp.MustCompile(key + ` (\d+) 0 R`).FindStringSubmatch(dict)
		if mm == nil {
			t.Fatalf("no %s in %s", key, dict)
		}
		return mm[1]
	}
	cmaps := map[string]map[string]string{}
	var out strings.Builder
	for _, pageID := range regexp.MustCompile(`(\d+) 0 R`).FindAllStringSubmatch(dicts["2"], -1) {
		page := dicts[pageID[1]]
		font := ""
		for _, line := range strings.Split(streams[ref(page, "/Contents")], "\n") {
			if f := regexp.MustCompile(`^/(F\d) 9 Tf$`).FindStringSubmatch(line); f != nil {
				font = ref(dicts[ref(page, "/"+f[1])], "/ToUnicode")
				if cmaps[font] == nil {
					cmaps[font] = map[string]string{}
					for _, bf := range regexp.MustCompile(`<([0-9A-F]{4})> <([0-9A-F]+)>`).FindAllStringSubmatch(streams[font], -1) {
						var u []uint16
						for i := 0; i < len(bf[2]); i += 4 {
							v, _ := strconv.ParseUint(bf[2][i:i+4], 16, 16)
							u = append(u, uint16(v))
						}
						cmaps[font][bf[1]] = string(utf16.Decode(u))
					}
				}
			}
			if s := regexp.MustCompile(`^<([0-9A-F]*)> '$`).FindStringSubmatch(line); s != nil {
				for i := 0; i < len(s[1]); i += 4 {
					out.WriteString(cmaps[font][s[1][i:i+4]])
				}
				out.WriteByte('\n')
			}
		}
	}
	return out.String()
}
