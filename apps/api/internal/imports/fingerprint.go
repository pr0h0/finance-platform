package imports

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Fingerprint fp1 — normative spec in docs/importing/fingerprint.md (shared with the TS importer SDK).

var refPlaceholders = map[string]bool{"NONREF": true, "NOTPROVIDED": true, "N/A": true, "NA": true, "-": true, "0": true}

// canonicalAmount: signed (debit '-'), no trailing fraction zeros, no leading integer zeros, zero is "0".
func canonicalAmount(amount string, direction string) string {
	a := strings.TrimPrefix(strings.TrimSpace(amount), "+")
	a = strings.TrimPrefix(a, "-")
	intPart, frac, _ := strings.Cut(a, ".")
	frac = strings.TrimRight(frac, "0")
	intPart = strings.TrimLeft(intPart, "0")
	if intPart == "" {
		intPart = "0"
	}
	s := intPart
	if frac != "" {
		s += "." + frac
	}
	if s == "0" {
		return "0"
	}
	if direction == "debit" {
		return "-" + s
	}
	return s
}

func canonicalRef(ref string) string {
	var b strings.Builder
	for _, r := range ref {
		if !unicode.IsSpace(r) {
			b.WriteRune(r)
		}
	}
	s := strings.ToUpper(b.String())
	if refPlaceholders[s] {
		return ""
	}
	return s
}

func canonicalDesc(desc string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(norm.NFKC.String(desc)) {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// fingerprintKey is the grouping key (without ordinal) of a record.
func fingerprintKey(r Record) []string {
	kind, val := "desc", canonicalDesc(r.Description)
	if ref := canonicalRef(r.BankReference); ref != "" {
		kind, val = "ref", ref
	}
	return []string{"fp1", r.PostingDate, canonicalAmount(r.Amount, r.Direction), strings.ToUpper(r.Currency), kind, val}
}

func fingerprintOf(key []string, ordinal int) string {
	sum := sha256.Sum256([]byte(strings.Join(key, "\x1f") + "\x1f" + strconv.Itoa(ordinal)))
	return "fp1:" + hex.EncodeToString(sum[:])
}

// Fingerprints returns the fp1 fingerprint of every record, numbering identical rows by occurrence
// in file order within each accountRef group (one account per group).
func Fingerprints(records []Record) []string {
	seen := map[string]int{}
	out := make([]string, len(records))
	for i, r := range records {
		key := fingerprintKey(r)
		k := r.AccountRef + "\x00" + strings.Join(key, "\x1f")
		seen[k]++
		out[i] = fingerprintOf(key, seen[k])
	}
	return out
}

func fillFingerprints(records []Record) {
	for i, fp := range Fingerprints(records) {
		records[i].Fingerprint = fp
	}
}

// descriptionWords splits NFKC-lowercased text into runs of letters or of digits ("KONZUM123 d.o.o."
// -> konzum 123 d o o). Same as descriptionWords in @finplat/importer-sdk.
func descriptionWords(s string) []string {
	var out []string
	var b strings.Builder
	kind := 0 // 1 letter, 2 digit
	for _, r := range strings.ToLower(norm.NFKC.String(s)) {
		k := 0
		switch {
		case unicode.IsLetter(r):
			k = 1
		case unicode.IsNumber(r):
			k = 2
		}
		if k != kind && b.Len() > 0 {
			out = append(out, b.String())
			b.Reset()
		}
		kind = k
		if k != 0 {
			b.WriteRune(r)
		}
	}
	if b.Len() > 0 {
		out = append(out, b.String())
	}
	return out
}
