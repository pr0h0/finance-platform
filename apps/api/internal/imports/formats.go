package imports

// Server-side ports of the bundled TS format importers (packages/bank-importers/src/formats).
// They must produce the same normalized records (and therefore the same fp1 fingerprints) for the
// same file; golden_test.go checks this against TS output for the shared fixtures.

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/text/encoding/charmap"

	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

var errTemplateRequired = errors.New("this importer needs a template (templateId)")

var compactDateRe = regexp.MustCompile(`^(\d{4})-?(\d{2})-?(\d{2})`)

func compactDate(s string) string {
	m := compactDateRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return ""
	}
	return m[1] + "-" + m[2] + "-" + m[3]
}

func joinNonEmpty(parts ...string) string {
	var out []string
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, " ")
}

// ---------- minimal markup tree (OFX SGML/XML) ----------

type node struct {
	name     string
	text     string
	children []*node
}

var markupTok = regexp.MustCompile(`<(/?)([A-Za-z0-9._:]+)[^>]*?(/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|([^<]+)`)

// parseMarkup builds a tree; an element directly followed by text is a leaf that needs no closing
// tag (SGML OFX 1.x), and unmatched closing tags are ignored.
func parseMarkup(src string) *node {
	root := &node{}
	stack := []*node{root}
	var leaf *node
	for _, m := range markupTok.FindAllStringSubmatch(src, -1) {
		switch {
		case m[4] != "":
			t := html.UnescapeString(m[4])
			if leaf != nil && strings.TrimSpace(t) != "" {
				leaf.text += strings.TrimSpace(t)
				stack, leaf = stack[:len(stack)-1], nil
			} else if leaf == nil {
				stack[len(stack)-1].text += t
			}
		case m[2] == "":
			// comment or processing instruction
		case m[1] == "/":
			leaf = nil
			name := localName(m[2])
			for i := len(stack) - 1; i > 0; i-- {
				if stack[i].name == name {
					stack = stack[:i]
					break
				}
			}
		default:
			n := &node{name: localName(m[2])}
			top := stack[len(stack)-1]
			top.children = append(top.children, n)
			if m[3] == "/" {
				leaf = nil
				continue
			}
			stack, leaf = append(stack, n), n
		}
		if len(stack) > 256 {
			break // nesting bomb
		}
	}
	return root
}

func localName(n string) string { return n[strings.Index(n, ":")+1:] }

func (n *node) find(path string) *node {
	cur := n
	for _, p := range strings.Split(path, "/") {
		if cur == nil {
			return nil
		}
		var next *node
		for _, c := range cur.children {
			if c.name == p {
				next = c
				break
			}
		}
		cur = next
	}
	return cur
}

func (n *node) textAt(path string) string {
	if n == nil {
		return ""
	}
	if f := n.find(path); f != nil {
		return strings.TrimSpace(f.text)
	}
	return ""
}

func (n *node) findAll(name string, out []*node) []*node {
	for _, c := range n.children {
		if c.name == name {
			out = append(out, c)
		} else {
			out = c.findAll(name, out)
		}
	}
	return out
}

func (n *node) kids(name string) []*node {
	var out []*node
	if n == nil {
		return out
	}
	for _, c := range n.children {
		if c.name == name {
			out = append(out, c)
		}
	}
	return out
}

// ---------- OFX / QFX ----------

var ofxAmountRe = regexp.MustCompile(`^[+-]?\d*\.?\d+$`)

func ofxAmount(s string) (string, bool) {
	v := strings.Replace(strings.TrimSpace(s), ",", ".", 1)
	if !ofxAmountRe.MatchString(v) {
		return "", false
	}
	v = strings.TrimPrefix(v, "+")
	if strings.HasPrefix(v, "-.") {
		v = "-0" + v[1:]
	} else if strings.HasPrefix(v, ".") {
		v = "0" + v
	}
	return v, true
}

var ofxTagCase = regexp.MustCompile(`<(/?)([A-Za-z0-9.]+)`)

func parseOFX(b []byte, pc ParseContext) (Result, error) {
	text, _, err := DecodeText(b, "auto")
	if err != nil {
		return Result{}, err
	}
	i := strings.Index(strings.ToUpper(text), "<OFX>")
	if i < 0 {
		return Result{}, errors.New("no <OFX> element")
	}
	body := text[i:]
	head := text
	if len(head) > 200 {
		head = head[:200]
	}
	if !strings.Contains(strings.ToLower(head), "<?xml") {
		body = ofxTagCase.ReplaceAllStringFunc(body, strings.ToUpper)
	}
	root := parseMarkup(body)
	out := newBuilder()
	stmts := root.findAll("CCSTMTRS", root.findAll("STMTRS", nil))
	if len(stmts) == 0 {
		out.errors = append(out.errors, Issue{Code: "no_statement", Message: "no bank or card statement"})
	}
	row := 0
	for _, s := range stmts {
		cur := s.textAt("CURDEF")
		if cur == "" {
			cur = pc.AccountCurrency
		}
		acct := s.textAt("BANKACCTFROM/ACCTID")
		if acct == "" {
			acct = s.textAt("CCACCTFROM/ACCTID")
		}
		list := s.find("BANKTRANLIST")
		st := Statement{AccountRef: acct, Currency: cur, PeriodStart: compactDate(list.textAt("DTSTART")), PeriodEnd: compactDate(list.textAt("DTEND"))}
		if c, ok := ofxAmount(s.textAt("LEDGERBAL/BALAMT")); ok {
			st.ClosingBalance = c
		}
		out.statements = append(out.statements, st)
		for _, t := range list.kids("STMTTRN") {
			row++
			raw := map[string]string{}
			for _, c := range t.children {
				if v := strings.TrimSpace(c.text); v != "" {
					raw[c.name] = v
				}
			}
			date := compactDate(t.textAt("DTPOSTED"))
			amount, ok := ofxAmount(t.textAt("TRNAMT"))
			if date == "" || !ok {
				out.errors = append(out.errors, Issue{Row: row, Code: "invalid_transaction", Message: "STMTTRN without valid DTPOSTED/TRNAMT"})
				continue
			}
			var warnings []Issue
			curNode := t.find("CURRENCY")
			inForeign := curNode != nil
			if curNode == nil {
				curNode = t.find("ORIGCURRENCY")
			}
			foreign := curNode.textAt("CURSYM")
			rate := strings.Replace(curNode.textAt("CURRATE"), ",", ".", 1)
			signedAmt, origAmt := amount, ""
			if foreign != "" && rate != "" && knownCurrency(foreign) && knownCurrency(cur) && strings.ContainsAny(rate, "123456789") {
				var cerr error
				if inForeign { // TRNAMT is in the foreign currency: convert to the account currency
					origAmt = amount
					var fm money.Money
					if fm, cerr = money.Parse(amount, foreign); cerr == nil {
						var lm money.Money
						if lm, cerr = fm.Convert(cur, rate, money.DefaultRounding); cerr == nil {
							signedAmt = lm.Amount()
						}
					}
					warnings = append(warnings, Issue{Row: row, Field: "amount", Code: "converted_amount", Message: "converted from " + foreign + " at " + rate})
				} else {
					var lm, om money.Money
					if lm, cerr = money.Parse(strings.TrimPrefix(amount, "-"), cur); cerr == nil {
						if om, cerr = lm.ConvertInverse(foreign, rate, money.DefaultRounding); cerr == nil {
							origAmt = om.Amount()
						}
					}
				}
				if cerr != nil {
					out.errors = append(out.errors, Issue{Row: row, Field: "amount", Code: "amount_precision", Message: cerr.Error()})
					continue
				}
			}
			if foreign == "" {
				rate = ""
			}
			name := t.textAt("NAME")
			if name == "" {
				name = t.textAt("PAYEE/NAME")
			}
			ref := t.textAt("FITID")
			if ref == "" {
				ref = t.textAt("CHECKNUM")
			}
			conf := 1.0
			if len(warnings) > 0 {
				conf = 0.9
			}
			out.add(draft{rowNumber: row, postingDate: date, valueDate: compactDate(t.textAt("DTUSER")), signedAmount: signedAmt,
				currency: cur, description: joinNonEmpty(name, t.textAt("MEMO")), counterparty: name, bankReference: ref,
				accountRef: acct, raw: raw, warnings: warnings, confidence: conf, exchRate: rate,
				originalAmount: origAmt, originalCurrency: foreign})
		}
	}
	return out.finish(), nil
}

// ---------- QIF ----------

func qifAmount(s string) (string, bool) {
	v := strings.TrimSpace(s)
	lastComma, lastDot := strings.LastIndex(v, ","), strings.LastIndex(v, ".")
	dec := "."
	if lastComma > lastDot {
		after := len(v) - lastComma - 1
		switch {
		case lastDot >= 0:
			dec = ","
		case strings.Index(v, ",") != lastComma || after == 3:
			dec = "."
		default:
			dec = ","
		}
	}
	thou := ","
	if dec == "," {
		thou = "."
	}
	return parseAmountFmt(v, dec, thou)
}

var (
	qifISO   = regexp.MustCompile(`^(\d{4})-(\d{1,2})-(\d{1,2})$`)
	qifDMY   = regexp.MustCompile(`^(\d{1,2})[/.-](\d{1,2})(?:[/.-]|')\s*(\d{2}|\d{4})$`)
	qifDot   = regexp.MustCompile(`^\d{1,2}\.\d`)
	qifYear  = regexp.MustCompile(`^\d{4}-`)
	qifTypes = map[string]bool{"bank": true, "cash": true, "ccard": true, "oth a": true, "oth l": true}
)

func qifDateParts(s string) ([3]int, bool) {
	t := strings.Join(strings.Fields(s), "")
	if m := qifISO.FindStringSubmatch(t); m != nil {
		a, _ := strconv.Atoi(m[2])
		b, _ := strconv.Atoi(m[3])
		y, _ := strconv.Atoi(m[1])
		return [3]int{a, b, y}, true
	}
	m := qifDMY.FindStringSubmatch(t)
	if m == nil {
		return [3]int{}, false
	}
	a, _ := strconv.Atoi(m[1])
	b, _ := strconv.Atoi(m[2])
	y, _ := strconv.Atoi(m[3])
	if y < 100 {
		if y < 70 {
			y += 2000
		} else {
			y += 1900
		}
	}
	return [3]int{a, b, y}, true
}

func parseQIF(b []byte, pc ParseContext) (Result, error) {
	text, enc, err := DecodeText(b, "auto")
	if err != nil {
		return Result{}, err
	}
	out := newBuilder()
	out.encoding = enc
	type pending struct {
		line   int
		f      map[string]string
		splits []string
	}
	var items []pending
	typ, inAccount, skipped := "bank", false, 0
	var cur *pending
	for n, l := range strings.Split(strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(text), "\n") {
		t := strings.TrimRight(l, " \t")
		if t == "" {
			continue
		}
		if t[0] == '!' {
			h := strings.ToLower(t)
			inAccount = strings.HasPrefix(h, "!account")
			if strings.HasPrefix(h, "!type:") {
				typ = strings.TrimSpace(h[6:])
			}
			continue
		}
		if t == "^" {
			if cur != nil && !inAccount {
				if qifTypes[typ] {
					items = append(items, *cur)
				} else {
					skipped++
				}
			}
			cur, inAccount = nil, false
			continue
		}
		if inAccount {
			continue
		}
		if cur == nil {
			cur = &pending{line: n + 1, f: map[string]string{}}
		}
		code, val := t[:1], t[1:]
		if code == "S" || code == "E" || code == "$" {
			cur.splits = append(cur.splits, t)
		} else if prev, ok := cur.f[code]; ok {
			cur.f[code] = prev + " " + val
		} else {
			cur.f[code] = val
		}
		if len(items) > maxRecords {
			break
		}
	}
	if cur != nil && len(cur.f) > 0 {
		items = append(items, *cur)
	}
	if skipped > 0 {
		out.warnings = append(out.warnings, Issue{Code: "unsupported_type", Message: fmt.Sprintf("%d records of type %s skipped", skipped, typ)})
	}
	parts := make([][3]int, len(items))
	okParts := make([]bool, len(items))
	firstGT12, secondGT12, anyDot, anyISO := false, false, false, false
	for i, it := range items {
		parts[i], okParts[i] = qifDateParts(it.f["D"])
		firstGT12 = firstGT12 || (okParts[i] && parts[i][0] > 12)
		secondGT12 = secondGT12 || (okParts[i] && parts[i][1] > 12)
		anyDot = anyDot || qifDot.MatchString(it.f["D"])
		anyISO = anyISO || qifYear.MatchString(strings.TrimSpace(it.f["D"]))
	}
	dayFirst := firstGT12 || (!secondGT12 && anyDot)
	ambiguous := !firstGT12 && !secondGT12 && !anyISO
	if ambiguous && len(items) > 0 {
		order := "MM/DD"
		if dayFirst {
			order = "DD/MM"
		}
		out.warnings = append(out.warnings, Issue{Code: "ambiguous_date_order", Message: "all dates fit both orders; assumed " + order})
	}
	for i, it := range items {
		p := parts[i]
		date, ok := "", false
		if okParts[i] {
			if qifYear.MatchString(strings.TrimSpace(it.f["D"])) || !dayFirst {
				date, ok = isoDateOf(p[2], p[0], p[1])
			} else {
				date, ok = isoDateOf(p[2], p[1], p[0])
			}
		}
		if !ok {
			out.errors = append(out.errors, Issue{Row: it.line, Field: "D", Code: "invalid_date", Message: fmt.Sprintf("bad date %q", it.f["D"])})
			continue
		}
		amtS, has := it.f["T"]
		if !has {
			amtS = it.f["U"]
		}
		amount, ok := qifAmount(amtS)
		if !ok {
			out.errors = append(out.errors, Issue{Row: it.line, Field: "T", Code: "invalid_amount", Message: fmt.Sprintf("bad amount %q", it.f["T"])})
			continue
		}
		var warnings []Issue
		raw := map[string]string{}
		for k, v := range it.f {
			raw[k] = v
		}
		if len(it.splits) > 0 {
			warnings = append(warnings, Issue{Row: it.line, Code: "qif_splits_ignored", Message: "QIF split lines kept in raw only"})
			raw["splits"] = strings.Join(it.splits, "\n")
		}
		conf := 1.0
		if ambiguous {
			conf = 0.7
		}
		out.add(draft{rowNumber: it.line, postingDate: date, signedAmount: amount, currency: pc.AccountCurrency,
			description: joinNonEmpty(it.f["P"], it.f["M"]), counterparty: it.f["P"], bankReference: it.f["N"],
			raw: raw, warnings: warnings, confidence: conf})
	}
	return out.finish(), nil
}

// ---------- ISO 20022 CAMT.053 / CAMT.054 (encoding/xml never resolves external entities) ----------

type camtAmt struct {
	Ccy   string `xml:"Ccy,attr"`
	Value string `xml:",chardata"`
}

type camtDate struct {
	Dt   string `xml:"Dt"`
	DtTm string `xml:"DtTm"`
}

func (d camtDate) date() string {
	if d.Dt != "" {
		return compactDate(d.Dt)
	}
	return compactDate(d.DtTm) // the date as printed; zone ignored on purpose
}

type camtParty struct {
	Nm  string `xml:"Nm"`
	Pty struct {
		Nm string `xml:"Nm"`
	} `xml:"Pty"`
}

func (p camtParty) name() string {
	if s := strings.TrimSpace(p.Nm); s != "" {
		return s
	}
	return strings.TrimSpace(p.Pty.Nm)
}

type camtXchg struct {
	XchgRate string `xml:"XchgRate"`
}

type camtTx struct {
	Refs struct {
		EndToEndId  string `xml:"EndToEndId"`
		AcctSvcrRef string `xml:"AcctSvcrRef"`
	} `xml:"Refs"`
	AmtDtls struct {
		InstdAmt struct {
			Amt     *camtAmt `xml:"Amt"`
			CcyXchg camtXchg `xml:"CcyXchg"`
		} `xml:"InstdAmt"`
		TxAmt struct {
			CcyXchg camtXchg `xml:"CcyXchg"`
		} `xml:"TxAmt"`
	} `xml:"AmtDtls"`
	RltdPties struct {
		Dbtr camtParty `xml:"Dbtr"`
		Cdtr camtParty `xml:"Cdtr"`
	} `xml:"RltdPties"`
	RmtInf struct {
		Ustrd []string `xml:"Ustrd"`
	} `xml:"RmtInf"`
}

type camtEntry struct {
	Amt       *camtAmt `xml:"Amt"`
	CdtDbtInd string   `xml:"CdtDbtInd"`
	RvslInd   string   `xml:"RvslInd"`
	Sts       struct {
		Text string `xml:",chardata"`
		Cd   string `xml:"Cd"`
	} `xml:"Sts"`
	BookgDt      camtDate `xml:"BookgDt"`
	ValDt        camtDate `xml:"ValDt"`
	AcctSvcrRef  string   `xml:"AcctSvcrRef"`
	AddtlNtryInf string   `xml:"AddtlNtryInf"`
	TxDtls       []camtTx `xml:"NtryDtls>TxDtls"`
	Inner        []byte   `xml:",innerxml"`
}

type camtStmt struct {
	Id   string `xml:"Id"`
	Acct struct {
		Id struct {
			IBAN string `xml:"IBAN"`
			Othr struct {
				Id string `xml:"Id"`
			} `xml:"Othr"`
		} `xml:"Id"`
		Ccy string `xml:"Ccy"`
	} `xml:"Acct"`
	Bal    []camtBal
	FrToDt struct {
		FrDtTm string `xml:"FrDtTm"`
		FrDt   string `xml:"FrDt"`
		ToDtTm string `xml:"ToDtTm"`
		ToDt   string `xml:"ToDt"`
	} `xml:"FrToDt"`
}

type camtBal struct {
	Tp struct {
		CdOrPrtry struct {
			Cd string `xml:"Cd"`
		} `xml:"CdOrPrtry"`
	} `xml:"Tp"`
	Amt       camtAmt `xml:"Amt"`
	CdtDbtInd string  `xml:"CdtDbtInd"`
}

func parseCAMT(kind string) func(b []byte, pc ParseContext) (Result, error) {
	return func(b []byte, pc ParseContext) (Result, error) {
		if bytes.Contains(bytes.ToUpper(b[:min(len(b), 4096)]), []byte("<!DOCTYPE")) {
			return Result{}, errors.New("camt: DOCTYPE/DTD is not allowed")
		}
		dec := xml.NewDecoder(bytes.NewReader(b))
		dec.CharsetReader = func(label string, in io.Reader) (io.Reader, error) {
			switch strings.ToLower(label) {
			case "windows-1250", "cp1250":
				return charmap.Windows1250.NewDecoder().Reader(in), nil
			case "iso-8859-2", "latin2":
				return charmap.ISO8859_2.NewDecoder().Reader(in), nil
			}
			return nil, fmt.Errorf("unsupported XML encoding %q", label)
		}
		container, item := "BkToCstmrStmt", "Stmt"
		if kind == "054" {
			container, item = "BkToCstmrDbtCdtNtfctn", "Ntfctn"
		}
		// Token stream: each statement is read child by child and each Ntry is decoded and handed
		// to the builder on its own, so only one entry is held as a struct at a time.
		out := newBuilder()
		row, found := 0, false
		var path []string
		for {
			tok, err := dec.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				return Result{}, fmt.Errorf("camt: %w", err)
			}
			switch t := tok.(type) {
			case xml.StartElement:
				if t.Name.Local == item && len(path) == 2 && path[0] == "Document" && path[1] == container {
					found = true
					if err := camtStatement(dec, out, &row, pc); err != nil {
						return Result{}, fmt.Errorf("camt: %w", err)
					}
					continue
				}
				if path = append(path, t.Name.Local); len(path) > 256 {
					return Result{}, errors.New("camt: nesting too deep")
				}
			case xml.EndElement:
				path = path[:len(path)-1]
			}
		}
		if !found {
			return Result{}, fmt.Errorf("missing Document/%s", container)
		}
		return out.finish(), nil
	}
}

// camtStatement consumes one Stmt/Ntfctn element (its start tag already read). Id and Acct precede
// Ntry in every CAMT version, so entries see the statement's reference and account.
func camtStatement(dec *xml.Decoder, out *builder, row *int, pc ParseContext) error {
	var s camtStmt
	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch t := tok.(type) {
		case xml.EndElement:
			out.statements = append(out.statements, camtStatementInfo(&s))
			return nil
		case xml.StartElement:
			switch t.Name.Local {
			case "Ntry":
				var e camtEntry
				if err := dec.DecodeElement(&e, &t); err != nil {
					return err
				}
				*row++
				addCAMTEntry(out, e, *row, s.Id, firstNonEmpty(s.Acct.Id.IBAN, s.Acct.Id.Othr.Id), firstNonEmpty(s.Acct.Ccy, pc.AccountCurrency))
			case "Id":
				err = dec.DecodeElement(&s.Id, &t)
			case "Acct":
				err = dec.DecodeElement(&s.Acct, &t)
			case "FrToDt":
				err = dec.DecodeElement(&s.FrToDt, &t)
			case "Bal":
				var bal camtBal
				err = dec.DecodeElement(&bal, &t)
				s.Bal = append(s.Bal, bal)
			default:
				err = dec.Skip()
			}
			if err != nil {
				return err
			}
		}
	}
}

func camtStatementInfo(s *camtStmt) Statement {
	acct := firstNonEmpty(s.Acct.Id.IBAN, s.Acct.Id.Othr.Id)
	st := Statement{Ref: s.Id, AccountRef: acct, Currency: s.Acct.Ccy,
		PeriodStart: compactDate(firstNonEmpty(s.FrToDt.FrDtTm, s.FrToDt.FrDt)), PeriodEnd: compactDate(firstNonEmpty(s.FrToDt.ToDtTm, s.FrToDt.ToDt))}
	var openCcy, closeCcy string
	for _, set := range []map[string]bool{{"OPBD": true, "PRCD": true}, {"CLBD": true}} {
		for _, bal := range s.Bal {
			v := strings.TrimSpace(bal.Amt.Value)
			if !set[bal.Tp.CdOrPrtry.Cd] || v == "" {
				continue
			}
			if bal.CdtDbtInd == "DBIT" && strings.ContainsAny(v, "123456789") {
				v = "-" + v
			}
			if set["OPBD"] {
				st.OpeningBalance, openCcy = v, bal.Amt.Ccy
			} else {
				st.ClosingBalance, closeCcy = v, bal.Amt.Ccy
			}
			break
		}
	}
	if st.Currency == "" {
		st.Currency = firstNonEmpty(openCcy, closeCcy)
	}
	return st
}

func addCAMTEntry(out *builder, e camtEntry, row int, ref, acct, ccy string) {
	raw := map[string]string{"xml": clip(strings.TrimSpace(string(e.Inner)))}
	status := firstNonEmpty(strings.TrimSpace(e.Sts.Text), strings.TrimSpace(e.Sts.Cd))
	if status != "" && status != "BOOK" {
		out.warnings = append(out.warnings, Issue{Row: row, Code: "not_booked", Message: "entry status " + status + " skipped"})
		return
	}
	date := firstNonEmpty(e.BookgDt.date(), e.ValDt.date())
	if e.Amt == nil || strings.TrimSpace(e.Amt.Value) == "" || date == "" || (e.CdtDbtInd != "CRDT" && e.CdtDbtInd != "DBIT") {
		out.errors = append(out.errors, Issue{Row: row, Code: "invalid_entry", Message: "Ntry without Amt, CdtDbtInd or BookgDt"})
		return
	}
	var warnings []Issue
	debit := e.CdtDbtInd == "DBIT"
	if e.RvslInd == "true" {
		debit = !debit
		warnings = append(warnings, Issue{Row: row, Code: "reversal", Message: "reversal entry"})
	}
	var tx camtTx
	if len(e.TxDtls) > 0 {
		tx = e.TxDtls[0]
	}
	if len(e.TxDtls) > 1 {
		warnings = append(warnings, Issue{Row: row, Code: "batched_entry", Message: fmt.Sprintf("%d transactions in one entry", len(e.TxDtls))})
	}
	counterparty := tx.RltdPties.Dbtr.name()
	if debit {
		counterparty = tx.RltdPties.Cdtr.name()
	}
	desc := []string{counterparty}
	for _, t := range e.TxDtls {
		for _, u := range t.RmtInf.Ustrd {
			desc = append(desc, strings.TrimSpace(u))
		}
	}
	desc = append(desc, strings.TrimSpace(e.AddtlNtryInf))
	currency := firstNonEmpty(e.Amt.Ccy, ccy)
	dir := "credit"
	if debit {
		dir = "debit"
	}
	d := draft{rowNumber: row, postingDate: date, valueDate: e.ValDt.date(), amount: strings.TrimSpace(e.Amt.Value),
		direction: dir, currency: currency, description: joinNonEmpty(desc...), counterparty: counterparty,
		accountRef: acct, statementRef: ref, raw: raw, warnings: warnings,
		bankReference: firstNonEmpty(strings.TrimSpace(e.AcctSvcrRef), firstNonEmpty(strings.TrimSpace(tx.Refs.AcctSvcrRef), strings.TrimSpace(tx.Refs.EndToEndId)))}
	if ia := tx.AmtDtls.InstdAmt.Amt; ia != nil && ia.Ccy != currency {
		d.originalAmount, d.originalCurrency = strings.TrimSpace(ia.Value), ia.Ccy
		d.exchRate = firstNonEmpty(strings.TrimSpace(tx.AmtDtls.InstdAmt.CcyXchg.XchgRate), strings.TrimSpace(tx.AmtDtls.TxAmt.CcyXchg.XchgRate))
	}
	if len(e.TxDtls) > 1 {
		d.confidence = 0.9
	}
	out.add(d)
}

// ---------- SWIFT MT940 ----------

var (
	mt940Tag  = regexp.MustCompile(`^:(\d{2}[A-Z]?):(.*)$`)
	mt940Bal  = regexp.MustCompile(`^([CD])(\d{6})([A-Z]{3})(\d+,\d*)$`)
	mt940Line = regexp.MustCompile(`^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+,\d*)([A-Z][A-Z0-9]{3})([^/]*?)(?://(.*))?$`)
)

func yymmdd(s string) (string, bool) {
	y, _ := strconv.Atoi(s[0:2])
	m, _ := strconv.Atoi(s[2:4])
	d, _ := strconv.Atoi(s[4:6])
	if y < 70 {
		y += 2000
	} else {
		y += 1900
	}
	return isoDateOf(y, m, d)
}

func mtAmount(s string) string {
	i, f, _ := strings.Cut(s, ",")
	if f != "" {
		return i + "." + f
	}
	return i
}

type mtField struct {
	tag, value string
	line       int
}

func parseMT940(b []byte, _ ParseContext) (Result, error) {
	text, enc, err := DecodeText(b, "auto")
	if err != nil {
		return Result{}, err
	}
	out := newBuilder()
	out.encoding = enc
	var fields []mtField
	flush := func() {
		if len(fields) > 0 {
			mtStatement(out, fields)
		}
		fields = nil
	}
	for n, l := range strings.Split(strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(text), "\n") {
		t := strings.TrimRight(l, " \t")
		if t == "-" || strings.HasPrefix(t, "-}") || t == "" {
			if t != "" {
				flush()
			}
			continue
		}
		if strings.HasPrefix(t, "{") {
			continue
		}
		if m := mt940Tag.FindStringSubmatch(t); m != nil {
			if m[1] == "20" {
				for _, x := range fields {
					if x.tag == "61" || x.tag == "62F" {
						flush()
						break
					}
				}
			}
			fields = append(fields, mtField{m[1], m[2], n + 1})
		} else if len(fields) > 0 {
			fields[len(fields)-1].value += "\n" + t
		}
		if len(fields) > 4*maxRecords {
			break
		}
	}
	flush()
	if len(out.statements) == 0 {
		return Result{}, errors.New("not an MT940 file")
	}
	return out.finish(), nil
}

func mtStatement(out *builder, fields []mtField) {
	get := func(tag string) string {
		for _, f := range fields {
			if f.tag == tag {
				return f.value
			}
		}
		return ""
	}
	ref, acct := strings.TrimSpace(get("20")), strings.TrimSpace(get("25"))
	st := Statement{Ref: ref, AccountRef: acct}
	sign := func(m []string) string {
		if m[1] == "D" {
			return "-" + mtAmount(m[4])
		}
		return mtAmount(m[4])
	}
	if ob := mt940Bal.FindStringSubmatch(strings.TrimSpace(firstNonEmpty(get("60F"), get("60M")))); ob != nil {
		st.OpeningBalance, st.Currency = sign(ob), ob[3]
		st.PeriodStart, _ = yymmdd(ob[2])
	}
	if cb := mt940Bal.FindStringSubmatch(strings.TrimSpace(firstNonEmpty(get("62F"), get("62M")))); cb != nil {
		st.ClosingBalance = sign(cb)
		if st.Currency == "" {
			st.Currency = cb[3]
		}
		st.PeriodEnd, _ = yymmdd(cb[2])
	}
	if st.Currency == "" {
		out.errors = append(out.errors, Issue{Code: "missing_balance", Message: "statement " + ref + " has no :60F: currency"})
	}
	out.statements = append(out.statements, st)
	for i, f := range fields {
		if f.tag != "61" {
			continue
		}
		lines := strings.Split(f.value, "\n")
		first, rest := lines[0], lines[1:]
		mm := mt940Line.FindStringSubmatch(strings.TrimSpace(first))
		if mm == nil {
			out.errors = append(out.errors, Issue{Row: f.line, Code: "invalid_61", Message: "cannot parse :61: " + first})
			continue
		}
		valueDate, ok := yymmdd(mm[1])
		if !ok {
			out.errors = append(out.errors, Issue{Row: f.line, Code: "invalid_date", Message: "bad date in :61: " + first})
			continue
		}
		posting := valueDate
		if mm[2] != "" { // entry date MMDD; its year follows the value date across the year end
			y, _ := strconv.Atoi(valueDate[:4])
			em, _ := strconv.Atoi(mm[2][:2])
			ed, _ := strconv.Atoi(mm[2][2:])
			vm, _ := strconv.Atoi(valueDate[5:7])
			if em == 12 && vm == 1 {
				y--
			} else if em == 1 && vm == 12 {
				y++
			}
			if p, ok := isoDateOf(y, em, ed); ok {
				posting = p
			}
		}
		var warnings []Issue
		mark := mm[3]
		debit := mark == "D" || mark == "RC"
		if strings.HasPrefix(mark, "R") {
			warnings = append(warnings, Issue{Row: f.line, Code: "reversal", Message: "reversal " + mark})
		}
		info := ""
		raw := map[string]string{"61": f.value}
		if i+1 < len(fields) && fields[i+1].tag == "86" {
			info = strings.ReplaceAll(fields[i+1].value, "\n", " ")
			raw["86"] = fields[i+1].value
		}
		custRef, bankRef := strings.TrimSpace(mm[7]), strings.TrimSpace(mm[8])
		desc := strings.TrimSpace(joinNonEmpty(info, strings.Join(rest, " ")))
		if desc == "" {
			desc = custRef
		}
		dir := "credit"
		if debit {
			dir = "debit"
		}
		out.add(draft{rowNumber: f.line, postingDate: posting, valueDate: valueDate, amount: mtAmount(mm[5]), direction: dir,
			currency: st.Currency, description: desc, bankReference: firstNonEmpty(bankRef, custRef), accountRef: acct,
			statementRef: ref, raw: raw, warnings: warnings})
	}
}

// ---------- finplat JSON interchange (docs/importing/formats.md) ----------

var signedDecimal = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

// parseFinplatJSON reads {"format":"finplat-import","version":1,"statements":[…],"transactions":[…]}
// or a bare array of transactions. Amounts must be decimal strings (numbers are rejected: no floats).
func parseFinplatJSON(b []byte, pc ParseContext) (Result, error) {
	text, _, err := DecodeText(b, "auto")
	if err != nil {
		return Result{}, err
	}
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil {
		return Result{}, errors.New("file is not valid JSON")
	}
	out := newBuilder()
	str := func(v any) string { s, _ := v.(string); return s }
	txs := doc
	if d, ok := doc.(map[string]any); ok {
		if d["format"] != "finplat-import" || fmt.Sprint(d["version"]) != "1" {
			return Result{}, errors.New(`expected format "finplat-import" version 1`)
		}
		txs = d["transactions"]
		if sts, ok := d["statements"].([]any); ok {
			for _, s := range sts {
				o, _ := s.(map[string]any)
				out.statements = append(out.statements, Statement{Ref: str(o["ref"]), AccountRef: str(o["accountRef"]), PeriodStart: str(o["periodStart"]),
					PeriodEnd: str(o["periodEnd"]), OpeningBalance: str(o["openingBalance"]), ClosingBalance: str(o["closingBalance"]), Currency: str(o["currency"])})
			}
		}
	}
	arr, ok := txs.([]any)
	if !ok {
		return Result{}, errors.New("transactions must be an array")
	}
	for i, t := range arr {
		row := i + 1
		o, ok := t.(map[string]any)
		if !ok {
			out.errors = append(out.errors, Issue{Row: row, Code: "invalid_record", Message: "not an object"})
			continue
		}
		if _, isNum := o["amount"].(json.Number); isNum {
			out.errors = append(out.errors, Issue{Row: row, Field: "amount", Code: "invalid_amount", Message: "amount must be a decimal string, not a number"})
			continue
		}
		date, amount := str(o["postingDate"]), str(o["amount"])
		if !isoDate.MatchString(date) || !signedDecimal.MatchString(amount) {
			out.errors = append(out.errors, Issue{Row: row, Code: "invalid_record", Message: "postingDate (YYYY-MM-DD) and amount (signed decimal string) are required"})
			continue
		}
		raw := map[string]string{}
		for k, v := range o {
			switch x := v.(type) {
			case nil:
			case string:
				raw[k] = x
			default:
				j, _ := json.Marshal(x)
				raw[k] = string(j)
			}
		}
		out.add(draft{rowNumber: row, postingDate: date, valueDate: str(o["valueDate"]), signedAmount: amount,
			currency: firstNonEmpty(str(o["currency"]), pc.AccountCurrency), description: str(o["description"]),
			bankReference: str(o["reference"]), counterparty: str(o["counterparty"]), accountRef: str(o["accountRef"]),
			statementRef: str(o["statementRef"]), runningBalance: str(o["runningBalance"]), originalAmount: str(o["originalAmount"]),
			originalCurrency: str(o["originalCurrency"]), exchRate: str(o["exchangeRate"]), raw: raw})
	}
	return out.finish(), nil
}
