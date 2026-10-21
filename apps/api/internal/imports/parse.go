package imports

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"

	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// Normalized parser output. JSON shape = ImportResult of packages/importer-sdk/src/types.ts.

type Issue struct {
	Row     int    `json:"row,omitempty"`
	Field   string `json:"field,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Record struct {
	RowNumber        int               `json:"rowNumber"`
	AccountRef       string            `json:"accountRef,omitempty"`
	StatementRef     string            `json:"statementRef,omitempty"`
	PostingDate      string            `json:"postingDate"`
	ValueDate        string            `json:"valueDate,omitempty"`
	Description      string            `json:"description"`
	Direction        string            `json:"direction"` // debit | credit
	Amount           string            `json:"amount"`    // positive magnitude at currency scale
	Currency         string            `json:"currency"`
	OriginalAmount   string            `json:"originalAmount,omitempty"`
	OriginalCurrency string            `json:"originalCurrency,omitempty"`
	ExchangeRate     string            `json:"exchangeRate,omitempty"`
	RunningBalance   string            `json:"runningBalance,omitempty"` // signed
	BankReference    string            `json:"bankReference,omitempty"`
	Counterparty     string            `json:"counterparty,omitempty"`
	Raw              map[string]string `json:"raw"`
	Fingerprint      string            `json:"fingerprint,omitempty"` // recomputed by the server
	Confidence       float64           `json:"confidence"`
	Warnings         []Issue           `json:"warnings"`
}

type Statement struct {
	Ref            string `json:"ref,omitempty"`
	AccountRef     string `json:"accountRef,omitempty"`
	PeriodStart    string `json:"periodStart,omitempty"`
	PeriodEnd      string `json:"periodEnd,omitempty"`
	OpeningBalance string `json:"openingBalance,omitempty"` // signed
	ClosingBalance string `json:"closingBalance,omitempty"` // signed
	Currency       string `json:"currency,omitempty"`
}

type Result struct {
	ImporterID       string      `json:"importerId,omitempty"`
	ImporterVersion  string      `json:"importerVersion,omitempty"`
	Format           string      `json:"format,omitempty"`
	Encoding         string      `json:"encoding,omitempty"`
	Records          []Record    `json:"records"`
	Statements       []Statement `json:"statements"`
	Errors           []Issue     `json:"errors"`
	Warnings         []Issue     `json:"warnings"`
	Confidence       float64     `json:"confidence"`
	RequiresApproval bool        `json:"requiresApproval,omitempty"`
}

// ParseContext is what a parser may know besides the bytes.
type ParseContext struct {
	AccountCurrency string
	Template        *Template // required by template-driven importers
}

// draft mirrors RecordDraft (records.ts): either signedAmount, or amount + direction.
type draft struct {
	rowNumber                                   int
	postingDate, valueDate                      string
	signedAmount, amount, direction, currency   string
	description, accountRef, statementRef       string
	originalAmount, originalCurrency, exchRate  string
	runningBalance, bankReference, counterparty string
	raw                                         map[string]string
	confidence                                  float64
	warnings                                    []Issue
}

type builder struct {
	records          []Record
	errors, warnings []Issue
	statements       []Statement
	encoding         string
}

func newBuilder() *builder {
	return &builder{errors: []Issue{}, warnings: []Issue{}, statements: []Statement{}}
}

var currencyAliases = map[string]string{"KM": "BAM", "EURO": "EUR", "DIN": "RSD", "KN": "HRK"}

func normalizeCurrency(v string) string {
	v = strings.ToUpper(strings.TrimSpace(v))
	if a, ok := currencyAliases[v]; ok {
		return a
	}
	return v
}

func knownCurrency(c string) bool {
	_, ok := money.Scale(c)
	return ok && len(c) == 3
}

// toScale rescales a decimal string to the currency's minor units (error on extra precision).
func toScale(amount, currency string) (string, error) {
	m, err := money.Parse(amount, currency)
	if err != nil {
		return "", err
	}
	return m.Amount(), nil
}

// add validates a draft like buildRecord: unknown currency, extra precision and zero amounts are
// issues instead of records.
func (b *builder) add(d draft) {
	row := d.rowNumber
	cur := normalizeCurrency(d.currency)
	fail := func(field, code, msg string) {
		i := Issue{Row: row, Field: field, Code: code, Message: msg}
		if code == "zero_amount" {
			b.warnings = append(b.warnings, i)
		} else {
			b.errors = append(b.errors, i)
		}
	}
	if cur == "" {
		fail("currency", "missing_currency", "no currency")
		return
	}
	if !knownCurrency(cur) {
		fail("currency", "unknown_currency", "unknown currency "+cur)
		return
	}
	dir, mag := d.direction, d.amount
	if d.signedAmount != "" {
		dir, mag = "credit", strings.TrimLeft(d.signedAmount, "+-")
		if strings.HasPrefix(d.signedAmount, "-") {
			dir = "debit"
		}
	}
	if mag == "" || dir == "" {
		fail("amount", "missing_amount", "no amount")
		return
	}
	mag = strings.TrimLeft(mag, "+-")
	amount, err := toScale(mag, cur)
	var running, orig string
	if err == nil && d.runningBalance != "" {
		running, err = toScale(d.runningBalance, cur)
	}
	if err == nil && d.originalAmount != "" && d.originalCurrency != "" && knownCurrency(d.originalCurrency) {
		orig, err = toScale(strings.TrimLeft(d.originalAmount, "+-"), d.originalCurrency)
	}
	if err != nil {
		fail("amount", "amount_precision", err.Error())
		return
	}
	if !strings.ContainsAny(amount, "123456789") {
		fail("amount", "zero_amount", "zero amount row skipped")
		return
	}
	conf := d.confidence
	if conf == 0 {
		conf = 1
	}
	w := d.warnings
	if w == nil {
		w = []Issue{}
	}
	rec := Record{RowNumber: row, PostingDate: d.postingDate, ValueDate: d.valueDate, Description: strings.Join(strings.Fields(d.description), " "),
		Direction: dir, Amount: amount, Currency: cur, Raw: d.raw, Confidence: conf, Warnings: w, AccountRef: d.accountRef,
		StatementRef: d.statementRef, RunningBalance: running, ExchangeRate: d.exchRate,
		BankReference: clip(d.bankReference), Counterparty: clip(d.counterparty)}
	if rec.Raw == nil {
		rec.Raw = map[string]string{}
	}
	if orig != "" {
		rec.OriginalAmount, rec.OriginalCurrency = orig, d.originalCurrency
	}
	if len(b.records) >= maxRecords {
		b.errors = append(b.errors, Issue{Code: "too_many_rows", Message: fmt.Sprintf("more than %d rows", maxRecords)})
		return
	}
	b.records = append(b.records, rec)
}

func (b *builder) finish() Result {
	recs := b.records
	if recs == nil {
		recs = []Record{}
	}
	fillFingerprints(recs)
	conf := 1.0
	for _, r := range recs {
		conf = min(conf, r.Confidence)
	}
	if len(recs) == 0 {
		conf = 0
	} else if len(b.errors) > 0 {
		conf *= float64(len(recs)) / float64(len(recs)+len(b.errors))
	}
	return Result{Encoding: b.encoding, Records: recs, Statements: b.statements, Errors: b.errors, Warnings: b.warnings, Confidence: conf}
}

// Limits for parser resource exhaustion (PLAN §45 file uploads).
const (
	maxRecords    = 100_000
	maxZipEntries = 16
	maxZipRatio   = 100 // uncompressed/compressed
	maxFieldLen   = 4096
)

var ErrTooLarge = errors.New("file exceeds the size limit")

// unwrapZip returns the single statement file inside a ZIP archive, enforcing entry count,
// size and compression-ratio limits (decompression bomb protection). Non-ZIP input is returned as is.
func unwrapZip(name string, b []byte, maxBytes int64) (string, []byte, error) {
	if !bytes.HasPrefix(b, []byte("PK\x03\x04")) {
		return name, b, nil
	}
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return "", nil, fmt.Errorf("invalid zip archive: %w", err)
	}
	if len(zr.File) > maxZipEntries {
		return "", nil, fmt.Errorf("zip archive has too many entries (max %d)", maxZipEntries)
	}
	var file *zip.File
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if strings.Contains(f.Name, "..") || path.IsAbs(f.Name) {
			return "", nil, errors.New("zip entry has an unsafe path")
		}
		if file != nil {
			return "", nil, errors.New("zip archive must contain exactly one statement file")
		}
		file = f
	}
	if file == nil {
		return "", nil, errors.New("zip archive is empty")
	}
	if file.UncompressedSize64 > uint64(maxBytes) ||
		(file.CompressedSize64 > 0 && file.UncompressedSize64/file.CompressedSize64 > maxZipRatio) {
		return "", nil, ErrTooLarge
	}
	rc, err := file.Open()
	if err != nil {
		return "", nil, err
	}
	defer rc.Close()
	// Never trust the header sizes: read at most maxBytes+1.
	out, err := io.ReadAll(io.LimitReader(rc, maxBytes+1))
	if err != nil {
		return "", nil, fmt.Errorf("zip: %w", err)
	}
	if int64(len(out)) > maxBytes || (file.CompressedSize64 > 0 && uint64(len(out))/file.CompressedSize64 > maxZipRatio) {
		return "", nil, ErrTooLarge
	}
	if bytes.HasPrefix(out, []byte("PK\x03\x04")) {
		return "", nil, errors.New("nested zip archives are not supported")
	}
	return path.Base(file.Name), out, nil
}

// DetectEncoding returns utf-8, utf-16le, utf-16be, windows-1250 or iso-8859-2.
func DetectEncoding(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte{0xEF, 0xBB, 0xBF}):
		return "utf-8"
	case bytes.HasPrefix(b, []byte{0xFF, 0xFE}):
		return "utf-16le"
	case bytes.HasPrefix(b, []byte{0xFE, 0xFF}):
		return "utf-16be"
	case utf8.Valid(b):
		return "utf-8"
	}
	// 0x80–0x9F are C1 controls in ISO-8859-2 but letters (Š š Ž ž ...) in Windows-1250.
	latin2Only := false
	for _, c := range b {
		if c >= 0x80 && c <= 0x9F {
			return "windows-1250"
		}
		// Š š Ž ž in ISO-8859-2 (in Windows-1250 these are ©, ą, ®, ľ — rare in BCS text).
		if c == 0xA9 || c == 0xB9 || c == 0xAE || c == 0xBE {
			latin2Only = true
		}
	}
	if latin2Only {
		return "iso-8859-2"
	}
	return "windows-1250"
}

// DecodeText converts b to UTF-8. enc "" or "auto" detects; BOMs are stripped.
func DecodeText(b []byte, enc string) (string, string, error) {
	enc = strings.ToLower(strings.TrimSpace(enc))
	if enc == "" || enc == "auto" {
		enc = DetectEncoding(b)
	}
	var out []byte
	var err error
	switch enc {
	case "utf-8", "utf8":
		enc = "utf-8"
		out = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF})
		if !utf8.Valid(out) {
			return "", enc, errors.New("file is not valid UTF-8")
		}
	case "utf-16le", "utf-16be":
		order := unicode.LittleEndian
		if enc == "utf-16be" {
			order = unicode.BigEndian
		}
		out, err = unicode.UTF16(order, unicode.UseBOM).NewDecoder().Bytes(b)
	case "windows-1250", "cp1250":
		enc = "windows-1250"
		out, err = charmap.Windows1250.NewDecoder().Bytes(b)
	case "iso-8859-2", "latin2":
		enc = "iso-8859-2"
		out, err = charmap.ISO8859_2.NewDecoder().Bytes(b)
	default:
		return "", enc, fmt.Errorf("unsupported encoding %q", enc)
	}
	if err != nil {
		return "", enc, fmt.Errorf("decode %s: %w", enc, err)
	}
	return string(out), enc, nil
}

var plainDecimal = regexp.MustCompile(`^\d+(\.\d+)?$`)

func clip(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > maxFieldLen {
		s = s[:maxFieldLen]
		for !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return s
}
