package imports

import (
	"bytes"
	"regexp"
	"strings"
)

// Manifest mirrors ImporterManifest of packages/importer-sdk (same ids as packages/bank-importers).
type Manifest struct {
	ID               string            `json:"id"`
	Version          string            `json:"version"`
	SDKVersion       int               `json:"sdkVersion"`
	Name             string            `json:"name"`
	Bank             map[string]string `json:"bank,omitempty"`
	Formats          []string          `json:"formats"`
	Status           string            `json:"status"` // stable | beta | blocked_external
	RequiresTemplate bool              `json:"requiresTemplate,omitempty"`
	Limitations      []string          `json:"limitations,omitempty"`
	ServerSide       bool              `json:"serverSide"` // false: only the web client can parse it
}

// Importer is a bundled, reviewed parser. Parsers are pure: bytes in, normalized records out.
type Importer struct {
	Manifest
	detect func(name string, head []byte) float64
	parse  func(b []byte, pc ParseContext) (Result, error)
}

func ext(name string) string {
	i := strings.LastIndex(name, ".")
	if i < 0 {
		return ""
	}
	return strings.ToLower(name[i+1:])
}

var (
	ofxHead   = regexp.MustCompile(`(?i)OFXHEADER:|<\?OFX|<OFX>`)
	intuit    = regexp.MustCompile(`(?i)INTU\.BID|<INTU\.`)
	mt940Head = regexp.MustCompile(`(?m)^:20:`)
	mt940Bal1 = regexp.MustCompile(`(?m)^:(60F|60M|61):`)
	mtAnyTag  = regexp.MustCompile(`(?m)^:\d{2}[A-Z]?:`)
	qifHead   = regexp.MustCompile(`(?im)^!Type:|^!Account`)
)

func m(id, name string, formats []string, limitations ...string) Manifest {
	return Manifest{ID: id, Version: "1.0.0", SDKVersion: 1, Name: name, Formats: formats, Status: "stable", Limitations: limitations, ServerSide: true}
}

func tabular(format string) Importer {
	man := m("generic-"+format, "Generic "+strings.ToUpper(format)+" (template)", []string{format})
	man.RequiresTemplate = true
	return Importer{man, func(name string, head []byte) float64 {
		if ext(name) == format || (format == "csv" && ext(name) == "txt") {
			return 0.5
		}
		return 0
	}, parseDelimited(format)}
}

// Registry: the server-side importers (connected mode, MCP, reprocessing). The web client runs the
// TS importers of packages/bank-importers (incl. XLSX/XLS/PDF/OCR) and stages their normalized result.
var Registry = []Importer{
	tabular("csv"),
	tabular("tsv"),
	{m("generic-ofx", "OFX (Open Financial Exchange)", []string{"ofx"}, "Investment statements (INVSTMTRS) are ignored.",
		"OFX carries only the closing balance; the statement cannot be fully reconciled.",
		"Foreign-currency rows are not converted on the server (flagged for review)."),
		func(name string, head []byte) float64 {
			if !ofxHead.Match(head) {
				return 0
			}
			if ext(name) == "qfx" {
				return 0.6
			}
			return 0.95
		}, parseOFX},
	{m("generic-qfx", "QFX (Quicken Web Connect)", []string{"qfx"}),
		func(name string, head []byte) float64 {
			if !ofxHead.Match(head) {
				return 0
			}
			if ext(name) == "qfx" || intuit.Match(head) {
				return 0.95
			}
			return 0.5
		}, parseOFX},
	{m("generic-qif", "QIF (Quicken Interchange Format)", []string{"qif"}, "QIF has no currency: the account currency is used.",
		"Day/month order is inferred from the whole file; when every date is ambiguous MM/DD is assumed (DD.MM for dot-separated dates).",
		"Split lines (S/E/$) are preserved in raw only."),
		func(name string, head []byte) float64 {
			if qifHead.Match(head) {
				return 0.95
			}
			if ext(name) == "qif" {
				return 0.5
			}
			return 0
		}, parseQIF},
	{m("generic-camt053", "ISO 20022 CAMT.053", []string{"camt053"}, "Batched entries become one record for the entry amount.", "Pending entries are skipped."),
		func(name string, head []byte) float64 {
			if bytes.Contains(head, []byte("camt.053.")) || bytes.Contains(head, []byte("<BkToCstmrStmt>")) {
				return 0.98
			}
			return 0
		}, parseCAMT("053")},
	{m("generic-camt054", "ISO 20022 CAMT.054", []string{"camt054"}, "Batched entries become one record for the entry amount.", "Pending entries are skipped."),
		func(name string, head []byte) float64 {
			if bytes.Contains(head, []byte("camt.054.")) || bytes.Contains(head, []byte("<BkToCstmrDbtCdtNtfctn>")) {
				return 0.98
			}
			return 0
		}, parseCAMT("054")},
	{m("generic-mt940", "SWIFT MT940", []string{"mt940"}, ":86: is used as the description as-is."),
		func(name string, head []byte) float64 {
			if mt940Head.Match(head) && mt940Bal1.Match(head) {
				return 0.95
			}
			if e := ext(name); (e == "sta" || e == "mt940" || e == "940") && mtAnyTag.Match(head) {
				return 0.6
			}
			return 0
		}, parseMT940},
	{m("generic-json", "JSON (finplat interchange)", []string{"json"}, `Only the documented "finplat-import" shape is accepted.`),
		func(name string, head []byte) float64 {
			h := bytes.TrimSpace(head)
			if regexp.MustCompile(`"format"\s*:\s*"finplat-import"`).Match(h) {
				return 0.98
			}
			if ext(name) == "json" && len(h) > 0 && (h[0] == '[' || h[0] == '{') {
				return 0.4
			}
			return 0
		}, parseFinplatJSON},
}

// ClientOnly lists importers that exist only in the web client (TS) because they need browser
// libraries (spreadsheets, PDF text, OCR). The server accepts their normalized output.
var ClientOnly = []Manifest{
	{ID: "generic-xlsx", Version: "1.0.0", SDKVersion: 1, Name: "Excel XLSX (template)", Formats: []string{"xlsx"}, Status: "stable", RequiresTemplate: true},
	{ID: "generic-xls", Version: "1.0.0", SDKVersion: 1, Name: "Excel 97-2003 XLS (template)", Formats: []string{"xls"}, Status: "stable", RequiresTemplate: true},
	{ID: "generic-pdf-text", Version: "1.0.0", SDKVersion: 1, Name: "Text PDF (template)", Formats: []string{"pdf"}, Status: "beta", RequiresTemplate: true},
	{ID: "generic-ocr", Version: "1.0.0", SDKVersion: 1, Name: "Scanned PDF / image (OCR, approval required)", Formats: []string{"pdf_ocr"}, Status: "beta", RequiresTemplate: true},
}

// Blocked lists importers whose real format is unknown. Raiffeisen Bank BiH (Feature 121) is
// BLOCKED_EXTERNAL until a sanitized sample statement is provided: never guess its format.
// When it arrives, add a parser to Registry with this id and synthetic fixtures; nothing else changes.
var Blocked = []Manifest{
	{ID: "raiffeisen-bih", Version: "0.0.0", SDKVersion: 1, Name: "Raiffeisen Bank BiH",
		Bank: map[string]string{"name": "Raiffeisen Bank d.d. Bosna i Hercegovina", "country": "BA"}, Formats: []string{}, Status: "blocked_external",
		Limitations: []string{"Waiting for a real (sanitized) statement sample. Use a CSV template, CAMT.053 or MT940 meanwhile."}},
}

func findImporter(id string) *Importer {
	for i := range Registry {
		if Registry[i].ID == id {
			return &Registry[i]
		}
	}
	return nil
}

func isBlocked(id string) bool {
	for _, b := range Blocked {
		if b.ID == id {
			return true
		}
	}
	return false
}

// Detect picks the most confident importer for a file (template-only importers only if a template is given).
func Detect(name string, b []byte, haveTemplate bool) *Importer {
	head := b
	if len(head) > 4096 {
		head = head[:4096]
	}
	var best *Importer
	bestScore := 0.0
	for i := range Registry {
		imp := &Registry[i]
		if imp.RequiresTemplate && !haveTemplate {
			continue
		}
		if s := imp.detect(name, head); s > bestScore {
			best, bestScore = imp, s
		}
	}
	return best
}
