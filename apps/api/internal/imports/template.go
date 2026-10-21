package imports

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Template is the declarative tabular template shared with the TS SDK
// (packages/importer-sdk/src/template.ts, docs/importing/templates.md). Data only: no code, no
// regex, no expressions; unknown keys are rejected. The server parses csv/tsv templates; xlsx and
// pdf templates are applied by the web client.
type Template struct {
	SchemaVersion   int    `json:"schemaVersion"`
	ID              string `json:"id"`
	Name            string `json:"name"`
	TemplateVersion string `json:"templateVersion,omitempty"`
	Bank            *struct {
		Name    string `json:"name"`
		Country string `json:"country,omitempty"`
		BIC     string `json:"bic,omitempty"`
	} `json:"bank,omitempty"`
	Format    string          `json:"format"`
	Encoding  string          `json:"encoding,omitempty"`
	Delimiter string          `json:"delimiter,omitempty"`
	Quote     *string         `json:"quote,omitempty"`
	Sheet     json.RawMessage `json:"sheet,omitempty"`
	SkipRows  int             `json:"skipRows,omitempty"`
	Header    *bool           `json:"header,omitempty"`
	Columns   struct {
		PostingDate      colRefs `json:"postingDate"`
		ValueDate        colRefs `json:"valueDate,omitempty"`
		Description      colRefs `json:"description"`
		Amount           colRefs `json:"amount,omitempty"`
		Debit            colRefs `json:"debit,omitempty"`
		Credit           colRefs `json:"credit,omitempty"`
		Direction        colRefs `json:"direction,omitempty"`
		Currency         colRefs `json:"currency,omitempty"`
		Reference        colRefs `json:"reference,omitempty"`
		RunningBalance   colRefs `json:"runningBalance,omitempty"`
		Counterparty     colRefs `json:"counterparty,omitempty"`
		AccountRef       colRefs `json:"accountRef,omitempty"`
		OriginalAmount   colRefs `json:"originalAmount,omitempty"`
		OriginalCurrency colRefs `json:"originalCurrency,omitempty"`
	} `json:"columns"`
	DateFormat      string `json:"dateFormat"`
	ValueDateFormat string `json:"valueDateFormat,omitempty"`
	Number          *struct {
		DecimalSeparator   string `json:"decimalSeparator"`
		ThousandsSeparator string `json:"thousandsSeparator"`
	} `json:"number"`
	AmountSign      string `json:"amountSign,omitempty"` // negative_is_debit (default) | positive_is_debit
	DirectionValues *struct {
		Debit  []string `json:"debit"`
		Credit []string `json:"credit"`
	} `json:"directionValues,omitempty"`
	Currency        string `json:"currency,omitempty"`
	SkipInvalidRows *bool  `json:"skipInvalidRows,omitempty"`
	Detect          *struct {
		HeaderIncludes   []string `json:"headerIncludes,omitempty"`
		FileNameIncludes []string `json:"fileNameIncludes,omitempty"`
	} `json:"detect,omitempty"`
}

// colRef is a header name (matched case-insensitively) or a 0-based column index.
type colRef struct {
	name  string
	index int
	isIdx bool
}

// colRefs: one reference, or (description only) an array of references joined by a space.
type colRefs []colRef

func (c *colRefs) UnmarshalJSON(b []byte) error {
	one := func(raw json.RawMessage) (colRef, error) {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			if s == "" || len(s) > 100 {
				return colRef{}, fmt.Errorf("column name must be 1-100 characters")
			}
			return colRef{name: s}, nil
		}
		var n int
		if err := json.Unmarshal(raw, &n); err != nil || n < 0 || n > 500 {
			return colRef{}, fmt.Errorf("column must be a header name or an index 0-500")
		}
		return colRef{index: n, isIdx: true}, nil
	}
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '[' {
		var arr []json.RawMessage
		if err := json.Unmarshal(b, &arr); err != nil || len(arr) < 1 || len(arr) > 5 {
			return fmt.Errorf("column list must have 1-5 entries")
		}
		for _, a := range arr {
			r, err := one(a)
			if err != nil {
				return err
			}
			*c = append(*c, r)
		}
		return nil
	}
	r, err := one(b)
	*c = colRefs{r}
	return err
}

func (c colRefs) MarshalJSON() ([]byte, error) {
	out := make([]any, len(c))
	for i, r := range c {
		if r.isIdx {
			out[i] = r.index
		} else {
			out[i] = r.name
		}
	}
	if len(out) == 1 {
		return json.Marshal(out[0])
	}
	return json.Marshal(out)
}

var (
	slugRe       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,63}$`)
	semverRe     = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	dateFormatRe = regexp.MustCompile(`^(YYYY|YY|MM|M|DD|D|[./\- ])+$`)
	countryRe    = regexp.MustCompile(`^[A-Z]{2}$`)
	bicRe        = regexp.MustCompile(`^[A-Z0-9]{8}([A-Z0-9]{3})?$`)
)

const maxTemplateBytes = 32 * 1024

// ParseTemplate decodes, defaults and validates a template definition (same rules as the TS zod schema).
func ParseTemplate(raw json.RawMessage) (*Template, map[string]string) {
	if len(raw) > maxTemplateBytes {
		return nil, map[string]string{"definition": "template too large"}
	}
	var t Template
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&t); err != nil {
		return nil, map[string]string{"definition": err.Error()}
	}
	e := map[string]string{}
	if t.SchemaVersion != 1 {
		e["definition.schemaVersion"] = "must be 1"
	}
	if !slugRe.MatchString(t.ID) {
		e["definition.id"] = "lowercase slug"
	}
	if t.Name == "" || len(t.Name) > 200 {
		e["definition.name"] = "1-200 characters"
	}
	if t.TemplateVersion == "" {
		t.TemplateVersion = "1.0.0"
	} else if !semverRe.MatchString(t.TemplateVersion) {
		e["definition.templateVersion"] = "semver x.y.z"
	}
	if t.Bank != nil && (t.Bank.Name == "" || (t.Bank.Country != "" && !countryRe.MatchString(t.Bank.Country)) || (t.Bank.BIC != "" && !bicRe.MatchString(t.Bank.BIC))) {
		e["definition.bank"] = "name required; country ISO alpha-2; bic 8 or 11 characters"
	}
	switch t.Format {
	case "csv", "tsv", "xlsx", "pdf":
	default:
		e["definition.format"] = "csv, tsv, xlsx or pdf"
	}
	if t.Encoding == "" {
		t.Encoding = "auto"
	}
	switch t.Encoding {
	case "auto", "utf-8", "utf-16le", "utf-16be", "windows-1250", "iso-8859-2":
	default:
		e["definition.encoding"] = "auto, utf-8, utf-16le, utf-16be, windows-1250 or iso-8859-2"
	}
	if t.Delimiter == "" {
		t.Delimiter = "auto"
	}
	switch t.Delimiter {
	case "auto", ";", ",", "\t", "|":
	default:
		e["definition.delimiter"] = "auto ; , tab or |"
	}
	if t.Quote == nil {
		q := `"`
		t.Quote = &q
	} else if *t.Quote != `"` && *t.Quote != "'" && *t.Quote != "" {
		e["definition.quote"] = `" ' or empty`
	}
	if t.SkipRows < 0 || t.SkipRows > 1000 {
		e["definition.skipRows"] = "0-1000"
	}
	if t.Header == nil {
		h := true
		t.Header = &h
	}
	c := t.Columns
	if len(c.PostingDate) != 1 {
		e["definition.columns.postingDate"] = "required (one column)"
	}
	if len(c.Description) == 0 {
		e["definition.columns.description"] = "required"
	}
	for name, refs := range map[string]colRefs{"valueDate": c.ValueDate, "amount": c.Amount, "debit": c.Debit, "credit": c.Credit,
		"direction": c.Direction, "currency": c.Currency, "reference": c.Reference, "runningBalance": c.RunningBalance,
		"counterparty": c.Counterparty, "accountRef": c.AccountRef, "originalAmount": c.OriginalAmount, "originalCurrency": c.OriginalCurrency} {
		if len(refs) > 1 {
			e["definition.columns."+name] = "a single column"
		}
	}
	if c.Amount == nil && c.Debit == nil && c.Credit == nil {
		e["definition.columns.amount"] = "map amount or debit/credit"
	}
	if c.Amount != nil && (c.Debit != nil || c.Credit != nil) {
		e["definition.columns.amount"] = "use amount OR debit/credit"
	}
	if c.Direction != nil && t.DirectionValues == nil {
		e["definition.directionValues"] = "required with a direction column"
	}
	if dv := t.DirectionValues; dv != nil && (len(dv.Debit) < 1 || len(dv.Debit) > 10 || len(dv.Credit) < 1 || len(dv.Credit) > 10) {
		e["definition.directionValues"] = "1-10 values each"
	}
	if !*t.Header {
		for _, refs := range []colRefs{c.PostingDate, c.ValueDate, c.Description, c.Amount, c.Debit, c.Credit, c.Direction, c.Currency,
			c.Reference, c.RunningBalance, c.Counterparty, c.AccountRef, c.OriginalAmount, c.OriginalCurrency} {
			for _, r := range refs {
				if !r.isIdx {
					e["definition.columns"] = "header:false needs column indexes"
				}
			}
		}
	}
	if len(t.DateFormat) > 20 || !dateFormatRe.MatchString(t.DateFormat) {
		e["definition.dateFormat"] = "tokens YYYY YY MM M DD D and . / - space"
	}
	if t.ValueDateFormat != "" && (len(t.ValueDateFormat) > 20 || !dateFormatRe.MatchString(t.ValueDateFormat)) {
		e["definition.valueDateFormat"] = "tokens YYYY YY MM M DD D and . / - space"
	}
	if n := t.Number; n == nil {
		e["definition.number"] = "required"
	} else if (n.DecimalSeparator != "." && n.DecimalSeparator != ",") || !strings.Contains("||.|,| |'|", "|"+n.ThousandsSeparator+"|") ||
		n.DecimalSeparator == n.ThousandsSeparator {
		e["definition.number"] = "decimalSeparator . or ,; thousandsSeparator '' . , space or '; they must differ"
	}
	if t.AmountSign == "" {
		t.AmountSign = "negative_is_debit"
	} else if t.AmountSign != "negative_is_debit" && t.AmountSign != "positive_is_debit" {
		e["definition.amountSign"] = "negative_is_debit or positive_is_debit"
	}
	if t.Currency != "" && !knownCurrency(t.Currency) {
		e["definition.currency"] = "unknown currency"
	}
	if t.SkipInvalidRows == nil {
		s := true
		t.SkipInvalidRows = &s
	}
	if len(e) > 0 {
		return nil, e
	}
	return &t, nil
}

// ---------- values (mirror packages/importer-sdk/src/values.ts) ----------

// ParseTemplateDate parses a printed date with a template format; a trailing time part is ignored.
func ParseTemplateDate(value, format string) (string, bool) {
	if !dateFormatRe.MatchString(format) {
		return "", false
	}
	var src strings.Builder
	src.WriteString("^")
	var order []string
	for i := 0; i < len(format); {
		tok := ""
		for _, t := range []string{"YYYY", "YY", "MM", "M", "DD", "D"} {
			if strings.HasPrefix(format[i:], t) {
				tok = t
				break
			}
		}
		if tok != "" {
			order = append(order, tok)
			switch {
			case tok == "YYYY":
				src.WriteString(`(\d{4})`)
			case len(tok) == 2:
				src.WriteString(`(\d{2})`)
			default:
				src.WriteString(`(\d{1,2})`)
			}
			i += len(tok)
			continue
		}
		if format[i] == ' ' {
			src.WriteString(`\s+`)
		} else {
			src.WriteString(regexp.QuoteMeta(format[i : i+1]))
		}
		i++
	}
	src.WriteString(`(?:$|[\sT])`)
	m := regexp.MustCompile(src.String()).FindStringSubmatch(strings.TrimSpace(value))
	if m == nil {
		return "", false
	}
	var y, mo, d int
	for i, tok := range order {
		n, _ := strconv.Atoi(m[i+1])
		switch {
		case tok == "YYYY":
			y = n
		case tok == "YY":
			y = 1900 + n
			if n < 70 {
				y = 2000 + n
			}
		case tok[0] == 'M':
			mo = n
		default:
			d = n
		}
	}
	return isoDateOf(y, mo, d)
}

func isoDateOf(y, m, d int) (string, bool) {
	if m < 1 || m > 12 || d < 1 || y < 1900 || y > 2999 {
		return "", false
	}
	t := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
	if t.Day() != d {
		return "", false
	}
	return t.Format(time.DateOnly), true
}

// parseAmountFmt parses a printed amount with an explicit number format into a signed plain
// decimal ("-1234.5"). Mirrors parseAmount in values.ts.
func parseAmountFmt(value, dec, thou string) (string, bool) {
	s := strings.TrimSpace(strings.NewReplacer(" ", " ", " ", " ").Replace(value))
	if s == "" {
		return "", false
	}
	neg := false
	if strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		neg, s = true, strings.TrimSpace(s[1:len(s)-1])
	}
	if strings.HasPrefix(s, "-") || strings.HasPrefix(s, "+") {
		neg = neg != (s[0] == '-')
		s = strings.TrimSpace(s[1:])
	} else if strings.HasSuffix(s, "-") {
		neg = !neg
		s = strings.TrimSpace(s[:len(s)-1])
	}
	if thou != "" {
		s = strings.ReplaceAll(s, thou, "")
	}
	if thou == " " || thou == "'" {
		s = strings.Join(strings.Fields(s), "")
	}
	if dec == "," {
		s = strings.Replace(s, ",", ".", 1)
	}
	if !plainDecimal.MatchString(s) {
		return "", false
	}
	for len(s) > 1 && s[0] == '0' && s[1] >= '0' && s[1] <= '9' {
		s = s[1:]
	}
	if neg && strings.ContainsAny(s, "123456789") {
		return "-" + s, true
	}
	return s, true
}

// ---------- tabular rows → records (mirror applyTemplate) ----------

type tableRow struct {
	line  int
	cells []string
}

func normHeader(s string) string {
	return strings.ToLower(strings.TrimSpace(strings.TrimPrefix(s, "\ufeff")))
}

func applyTemplate(t *Template, rows []tableRow, b *builder, fallbackCurrency string) {
	var names []string
	index := map[string]int{}
	type cols = map[string][]int
	var cm cols
	skipped := 0
	debitSet, creditSet := map[string]bool{}, map[string]bool{}
	if dv := t.DirectionValues; dv != nil {
		for _, v := range dv.Debit {
			debitSet[normHeader(v)] = true
		}
		for _, v := range dv.Credit {
			creditSet[normHeader(v)] = true
		}
	}
	c := t.Columns
	all := map[string]colRefs{"postingDate": c.PostingDate, "valueDate": c.ValueDate, "description": c.Description, "amount": c.Amount,
		"debit": c.Debit, "credit": c.Credit, "direction": c.Direction, "currency": c.Currency, "reference": c.Reference,
		"runningBalance": c.RunningBalance, "counterparty": c.Counterparty, "accountRef": c.AccountRef,
		"originalAmount": c.OriginalAmount, "originalCurrency": c.OriginalCurrency}
	for _, row := range rows {
		if skipped < t.SkipRows {
			skipped++
			continue
		}
		empty := true
		for _, x := range row.cells {
			if strings.TrimSpace(x) != "" {
				empty = false
				break
			}
		}
		if empty {
			continue
		}
		if cm == nil {
			if *t.Header {
				names = make([]string, len(row.cells))
				for i, x := range row.cells {
					names[i] = strings.TrimSpace(strings.TrimPrefix(x, "\ufeff"))
					if _, dup := index[normHeader(x)]; !dup {
						index[normHeader(x)] = i
					}
				}
			}
			cm = cols{}
			var missing []string
			for k, refs := range all {
				if refs == nil {
					continue
				}
				var idx []int
				ok := true
				for _, r := range refs {
					if r.isIdx {
						idx = append(idx, r.index)
					} else if i, found := index[normHeader(r.name)]; found {
						idx = append(idx, i)
					} else {
						ok = false
					}
				}
				if !ok {
					var labels []string
					for _, r := range refs {
						labels = append(labels, r.name)
					}
					missing = append(missing, k+"="+strings.Join(labels, "|"))
				}
				cm[k] = idx
			}
			if len(missing) > 0 {
				b.errors = append(b.errors, Issue{Code: "missing_column", Message: "columns not found: " + strings.Join(missing, ", ")})
				return
			}
			if *t.Header {
				continue
			}
		}
		cell := func(k string) (string, bool) {
			idx, ok := cm[k]
			if !ok {
				return "", false
			}
			var parts []string
			for _, i := range idx {
				if i < len(row.cells) {
					if v := strings.TrimSpace(row.cells[i]); v != "" {
						parts = append(parts, v)
					}
				}
			}
			return strings.Join(parts, " "), true
		}
		raw := map[string]string{}
		for i, x := range row.cells {
			k := "col_" + strconv.Itoa(i)
			if i < len(names) && names[i] != "" {
				k = names[i]
			}
			raw[k] = x
		}
		issue := func(code, field, msg string) Issue {
			return Issue{Row: row.line, Field: field, Code: code, Message: msg}
		}
		dateText, _ := cell("postingDate")
		posting, ok := ParseTemplateDate(dateText, t.DateFormat)
		if !ok {
			i := issue("invalid_date", "postingDate", fmt.Sprintf("cannot read date %q as %s", dateText, t.DateFormat))
			if *t.SkipInvalidRows {
				b.warnings = append(b.warnings, i)
			} else {
				b.errors = append(b.errors, i)
			}
			continue
		}
		var warnings []Issue
		valueDate := ""
		if vd, _ := cell("valueDate"); vd != "" {
			f := t.ValueDateFormat
			if f == "" {
				f = t.DateFormat
			}
			if valueDate, ok = ParseTemplateDate(vd, f); !ok {
				warnings = append(warnings, issue("invalid_value_date", "valueDate", fmt.Sprintf("ignored %q", vd)))
			}
		}
		amt := func(k string) (string, int) { // 0 absent, 1 ok, -1 unreadable
			v, _ := cell(k)
			if v == "" {
				return "", 0
			}
			if a, ok := parseAmountFmt(v, t.Number.DecimalSeparator, t.Number.ThousandsSeparator); ok {
				return a, 1
			}
			return "", -1
		}
		var signedAmt string
		if _, has := cm["amount"]; has {
			a, st := amt("amount")
			if st != 1 {
				v, _ := cell("amount")
				b.errors = append(b.errors, issue("invalid_amount", "amount", fmt.Sprintf("cannot read amount %q", v)))
				continue
			}
			if _, hasDir := cm["direction"]; hasDir {
				dv, _ := cell("direction")
				dv = normHeader(dv)
				mag := strings.TrimPrefix(a, "-")
				switch {
				case debitSet[dv]:
					signedAmt = "-" + mag
				case creditSet[dv]:
					signedAmt = mag
				default:
					b.errors = append(b.errors, issue("invalid_direction", "direction", fmt.Sprintf("unknown direction %q", dv)))
					continue
				}
			} else if t.AmountSign == "positive_is_debit" {
				if strings.HasPrefix(a, "-") {
					signedAmt = a[1:]
				} else {
					signedAmt = "-" + a
				}
			} else {
				signedAmt = a
			}
		} else {
			d, ds := amt("debit")
			cr, cs := amt("credit")
			if ds < 0 || cs < 0 {
				b.errors = append(b.errors, issue("invalid_amount", "amount", "cannot read debit/credit amount"))
				continue
			}
			dz := ds == 0 || !strings.ContainsAny(d, "123456789")
			cz := cs == 0 || !strings.ContainsAny(cr, "123456789")
			if !dz && !cz {
				b.errors = append(b.errors, issue("ambiguous_amount", "amount", "both debit and credit are filled"))
				continue
			}
			if dz && cz {
				b.warnings = append(b.warnings, issue("zero_amount", "amount", "no debit or credit amount; row skipped"))
				continue
			}
			if dz {
				signedAmt = strings.TrimPrefix(cr, "-")
			} else {
				signedAmt = "-" + strings.TrimPrefix(d, "-")
			}
		}
		running := ""
		if _, has := cm["runningBalance"]; has {
			rb, st := amt("runningBalance")
			if st < 0 {
				warnings = append(warnings, issue("invalid_balance", "runningBalance", "ignored unreadable balance"))
			} else {
				running = rb
			}
		}
		orig, _ := amt("originalAmount")
		cur, _ := cell("currency")
		if cur == "" {
			cur = t.Currency
		}
		if cur == "" {
			cur = fallbackCurrency
		}
		desc, _ := cell("description")
		ref, _ := cell("reference")
		cp, _ := cell("counterparty")
		acct, _ := cell("accountRef")
		oc, _ := cell("originalCurrency")
		conf := 1.0
		if len(warnings) > 0 {
			conf = 0.9
		}
		b.add(draft{rowNumber: row.line, postingDate: posting, valueDate: valueDate, signedAmount: signedAmt, currency: cur,
			description: desc, bankReference: ref, counterparty: cp, accountRef: acct, runningBalance: running,
			originalAmount: orig, originalCurrency: oc, raw: raw, warnings: warnings, confidence: conf})
	}
	if cm == nil {
		b.errors = append(b.errors, Issue{Code: "empty_file", Message: "no rows found"})
	}
}

// parseCSV mirrors parseCsv in csv.ts: RFC 4180 with a configurable (or disabled) quote char.
func parseCSV(text string, delim, quote rune) []tableRow {
	var rows []tableRow
	var cells []string
	var field strings.Builder
	inQuotes, quoteMaybeEnd, afterCR, rowHasData := false, false, false, false
	line, rowLine := 1, 1
	endRow := func() {
		cells = append(cells, field.String())
		if rowHasData || len(cells) > 1 || field.Len() > 0 {
			rows = append(rows, tableRow{line: rowLine, cells: cells})
		}
		cells, rowHasData = nil, false
		field.Reset()
	}
	for _, c := range text {
		if afterCR {
			afterCR = false
			if c == '\n' {
				continue
			}
		}
		if inQuotes {
			if quoteMaybeEnd {
				quoteMaybeEnd = false
				if c == quote {
					field.WriteRune(quote)
					continue
				}
				inQuotes = false
			} else if c == quote {
				quoteMaybeEnd = true
				continue
			} else {
				if c == '\n' || c == '\r' {
					line++
				}
				if c == '\r' {
					afterCR = true
				}
				field.WriteRune(c)
				continue
			}
		}
		switch {
		case c == delim:
			cells = append(cells, field.String())
			field.Reset()
			rowHasData = true
		case c == '\n' || c == '\r':
			if c == '\r' {
				afterCR = true
			}
			endRow()
			line++
			rowLine = line
		case c == quote && quote != 0 && field.Len() == 0:
			inQuotes, rowHasData = true, true
		default:
			field.WriteRune(c)
		}
		if len(rows) > maxRecords+1000 {
			break
		}
	}
	endRow()
	return rows
}

// sniffDelimiter mirrors csv.ts: the candidate whose (non-zero) count outside quotes is most
// consistent over the first 20 non-empty lines.
func sniffDelimiter(sample string) rune {
	var ls []string
	for _, l := range strings.FieldsFunc(sample, func(r rune) bool { return r == '\n' || r == '\r' }) {
		if strings.TrimSpace(l) != "" {
			ls = append(ls, l)
		}
		if len(ls) == 20 {
			break
		}
	}
	best, bestScore := ',', -1
	for _, d := range []rune{';', ',', '\t', '|'} {
		counts := make([]int, len(ls))
		freq := map[int]int{}
		for i, l := range ls {
			inQ := false
			for _, c := range l {
				if c == '"' {
					inQ = !inQ
				} else if c == d && !inQ {
					counts[i]++
				}
			}
			if counts[i] > 0 {
				freq[counts[i]]++
			}
		}
		if len(freq) == 0 {
			continue
		}
		mode, n := 0, 0
		for k, v := range freq {
			if v > n || (v == n && k > mode) {
				mode, n = k, v
			}
		}
		score := 0
		for _, c := range counts {
			if c == mode {
				score++
			}
		}
		if score = score*100 + mode; score > bestScore {
			best, bestScore = d, score
		}
	}
	return best
}

func parseDelimited(format string) func(b []byte, pc ParseContext) (Result, error) {
	return func(b []byte, pc ParseContext) (Result, error) {
		t := pc.Template
		if t == nil {
			return Result{}, errTemplateRequired
		}
		if t.Format != format && !(t.Format == "csv" && format == "tsv") && !(t.Format == "tsv" && format == "csv") {
			return Result{}, fmt.Errorf("template is for %s files; %s templates are applied by the web client", t.Format, t.Format)
		}
		text, enc, err := DecodeText(b, t.Encoding)
		if err != nil {
			return Result{}, err
		}
		var quote rune
		if *t.Quote != "" {
			quote = []rune(*t.Quote)[0]
		}
		delim := '\t'
		if format == "csv" {
			if t.Delimiter != "auto" {
				delim = []rune(t.Delimiter)[0]
			} else {
				head := text
				if len(head) > 64<<10 {
					head = head[:64<<10]
				}
				delim = sniffDelimiter(head)
			}
		}
		bl := newBuilder()
		bl.encoding = enc
		applyTemplate(t, parseCSV(text, delim, quote), bl, pc.AccountCurrency)
		return bl.finish(), nil
	}
}
