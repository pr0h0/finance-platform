package transactions

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
)

type cursor struct {
	D  string    `json:"d"`
	ID uuid.UUID `json:"i"`
}

// filter builds the WHERE clause for search and export (PLAN feature 10).
type filter struct {
	where []string
	args  []any
}

func (f *filter) add(cond string, v any) {
	f.args = append(f.args, v)
	f.where = append(f.where, strings.ReplaceAll(cond, "$?", "$"+strconv.Itoa(len(f.args))))
}

func likeArg(s string) string {
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s) + "%"
}

func parseFilter(q url.Values, profileID uuid.UUID) (*filter, error) {
	f := &filter{}
	f.add("t.profile_id = $?", profileID)
	bad := map[string]string{}
	if b, _ := strconv.ParseBool(q.Get("includeDeleted")); !b {
		f.where = append(f.where, "t.deleted_at IS NULL")
	}
	for _, k := range []string{"from", "to"} {
		if v := q.Get(k); v != "" {
			if ledger.ValidDate(v) != nil {
				bad[k] = "expected YYYY-MM-DD"
				continue
			}
			op := ">="
			if k == "to" {
				op = "<="
			}
			f.add("t.booking_date "+op+" $?::date", v)
		}
	}
	ids := func(key string) []uuid.UUID {
		var out []uuid.UUID
		for _, s := range q[key] {
			for _, part := range strings.Split(s, ",") {
				id, err := uuid.Parse(strings.TrimSpace(part))
				if err != nil {
					bad[key] = "invalid uuid"
					return nil
				}
				out = append(out, id)
			}
		}
		return out
	}
	if a := ids("accountId"); len(a) > 0 {
		f.add("EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.deleted_at IS NULL AND p.account_id = ANY($?))", a)
	}
	if c := ids("categoryId"); len(c) > 0 {
		// A parent category matches its subcategories too (feature 6: group at parent level).
		f.add(`EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.deleted_at IS NULL AND s.category_id IN (
			WITH RECURSIVE c AS (SELECT id FROM categories WHERE id = ANY($?) AND profile_id = t.profile_id
			UNION SELECT ch.id FROM categories ch JOIN c ON ch.parent_id = c.id) SELECT id FROM c))`, c)
	}
	if m := ids("merchantId"); len(m) > 0 {
		f.add("t.merchant_id = ANY($?)", m)
	}
	if tg := ids("tagId"); len(tg) > 0 {
		f.add("EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag_id = ANY($?))", tg)
	}
	if r := ids("relatedTransactionId"); len(r) > 0 {
		f.add("(t.related_transaction_id = ANY($?) OR t.corrects_transaction_id = ANY($?))", r)
	}
	if k := q.Get("kind"); k != "" {
		f.add("t.kind = ANY($?)", strings.Split(k, ","))
	}
	for _, k := range []string{"status", "source"} {
		if v := q.Get(k); v != "" {
			f.add("t."+k+" = ANY($?)", strings.Split(v, ","))
		}
	}
	if v := q.Get("currency"); v != "" {
		f.add("EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.deleted_at IS NULL AND p.currency = $?)", v)
	}
	if v := strings.TrimSpace(q.Get("q")); v != "" {
		if len(v) > 200 {
			bad["q"] = "at most 200 characters"
		}
		f.add(`(t.description ILIKE $? OR t.notes ILIKE $? OR t.payee ILIKE $? OR t.reference ILIKE $?
			OR EXISTS (SELECT 1 FROM merchants m WHERE m.id = t.merchant_id AND m.name ILIKE $?)
			OR EXISTS (SELECT 1 FROM imported_raw_records ir WHERE ir.id = t.import_record_id AND ir.source_description ILIKE $?))`, likeArg(v))
	}
	for k, op := range map[string]string{"minAmount": ">=", "maxAmount": "<="} {
		if v := q.Get(k); v != "" {
			if !decimalRE(v) {
				bad[k] = "expected a decimal string"
				continue
			}
			// magnitude of the primary (first) posting
			f.add("(SELECT abs(p.amount) FROM postings p WHERE p.transaction_id = t.id AND p.deleted_at IS NULL ORDER BY p.line_no LIMIT 1) "+op+" $?::numeric", v)
		}
	}
	if b, _ := strconv.ParseBool(q.Get("uncategorized")); b {
		f.where = append(f.where, "EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.deleted_at IS NULL AND s.category_id IS NULL)")
	}
	if len(bad) > 0 {
		return nil, httpx.Validation(bad)
	}
	return f, nil
}

func decimalRE(s string) bool {
	if s == "" || len(s) > 40 {
		return false
	}
	s = strings.TrimPrefix(s, "-")
	dot := false
	for i, c := range s {
		switch {
		case c >= '0' && c <= '9':
		case c == '.' && !dot && i > 0 && i < len(s)-1:
			dot = true
		default:
			return false
		}
	}
	return true
}

// search returns one keyset page (booking_date DESC, id DESC).
func search(ctx context.Context, db ledger.DB, f *filter, page httpx.Page) (httpx.List[*ledger.Transaction], error) {
	var c cursor
	if err := httpx.DecodeCursor(page.Cursor, &c); err != nil {
		return httpx.List[*ledger.Transaction]{}, err
	}
	g := *f
	g.where, g.args = append([]string{}, f.where...), append([]any{}, f.args...)
	if page.Cursor != "" {
		g.add("(t.booking_date, t.id) < (($?::jsonb->>'d')::date, ($?::jsonb->>'i')::uuid)", c)
	}
	g.args = append(g.args, page.Limit+1)
	sql := `SELECT ` + ledger.TxCols + ` FROM transactions t WHERE ` + strings.Join(g.where, " AND ") +
		` ORDER BY t.booking_date DESC, t.id DESC LIMIT $` + strconv.Itoa(len(g.args))
	items, err := ledger.Query(ctx, db, sql, g.args...)
	if err != nil {
		return httpx.List[*ledger.Transaction]{}, err
	}
	out := httpx.List[*ledger.Transaction]{Items: items}
	if out.Items == nil {
		out.Items = []*ledger.Transaction{}
	}
	if len(items) > page.Limit {
		out.Items = items[:page.Limit]
		last := out.Items[page.Limit-1]
		out.NextCursor = httpx.EncodeCursor(cursor{last.BookingDate, last.ID})
	}
	return out, nil
}

const exportMax = 200000

// export streams every matching transaction as CSV (one row per split, or per posting for
// uncategorized kinds — spreadsheet friendly) or as a JSON array of API transactions.
func export(ctx context.Context, w http.ResponseWriter, db ledger.DB, profileID uuid.UUID, f *filter, format string) error {
	names, err := loadNames(ctx, db, profileID)
	if err != nil {
		return err
	}
	stamp := time.Now().UTC().Format("20060102")
	var cw *csv.Writer
	switch format {
	case "csv", "":
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="transactions-`+stamp+`.csv"`)
		_, _ = w.Write([]byte("\xef\xbb\xbf")) // BOM: spreadsheets detect UTF-8
		cw = csv.NewWriter(w)
		_ = cw.Write([]string{"transaction_id", "booking_date", "value_date", "kind", "status", "account", "amount", "currency",
			"original_amount", "original_currency", "split_amount", "category", "description", "payee", "merchant", "tags", "notes",
			"source", "related_transaction_id", "excluded_from_reports"})
	case "json":
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="transactions-`+stamp+`.json"`)
		_, _ = w.Write([]byte(`{"items":[`))
	default:
		return httpx.Validation(map[string]string{"format": "csv or json"})
	}
	page := httpx.Page{Limit: 1000}
	n := 0
	for n < exportMax {
		res, err := search(ctx, db, f, page)
		if err != nil {
			return err
		}
		for _, t := range res.Items {
			if cw != nil {
				writeCSV(cw, t, names)
			} else {
				if n > 0 {
					_, _ = w.Write([]byte(","))
				}
				b, _ := json.Marshal(t)
				_, _ = w.Write(b)
			}
			n++
		}
		if cw != nil {
			cw.Flush()
		}
		if res.NextCursor == "" {
			break
		}
		page.Cursor = res.NextCursor
	}
	if cw == nil {
		_, _ = w.Write([]byte(`]}`))
	}
	return nil
}

type nameMaps struct{ accounts, categories, merchants, tags map[uuid.UUID]string }

func loadNames(ctx context.Context, db ledger.DB, profileID uuid.UUID) (*nameMaps, error) {
	n := &nameMaps{map[uuid.UUID]string{}, map[uuid.UUID]string{}, map[uuid.UUID]string{}, map[uuid.UUID]string{}}
	for sql, m := range map[string]map[uuid.UUID]string{
		`SELECT id, name FROM accounts WHERE profile_id = $1`:  n.accounts,
		`SELECT id, name FROM merchants WHERE profile_id = $1`: n.merchants,
		`SELECT id, name FROM tags WHERE profile_id = $1`:      n.tags,
		// "Parent / Child" path for categories
		`WITH RECURSIVE c AS (SELECT id, name::text AS path FROM categories WHERE profile_id = $1 AND parent_id IS NULL
			UNION ALL SELECT ch.id, c.path || ' / ' || ch.name FROM categories ch JOIN c ON ch.parent_id = c.id)
			SELECT id, path FROM c`: n.categories,
	} {
		rows, err := db.Query(ctx, sql, profileID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id uuid.UUID
			var name string
			if err := rows.Scan(&id, &name); err != nil {
				rows.Close()
				return nil, err
			}
			m[id] = name
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return n, nil
}

// cell neutralises spreadsheet formula injection in free-text cells (amount columns are never prefixed).
func cell(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

func writeCSV(cw *csv.Writer, t *ledger.Transaction, n *nameMaps) {
	var tags []string
	for _, id := range t.TagIDs {
		tags = append(tags, n.tags[id])
	}
	merchant := ""
	if t.MerchantID != nil {
		merchant = n.merchants[*t.MerchantID]
	}
	opt := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	related := ""
	if t.RelatedTransactionID != nil {
		related = t.RelatedTransactionID.String()
	}
	row := func(p ledger.Posting, splitAmt, category string) {
		oa, oc := "", ""
		if p.OriginalAmount != nil {
			oa, oc = p.OriginalAmount.Amount(), p.OriginalAmount.Currency()
		}
		_ = cw.Write([]string{t.ID.String(), t.BookingDate, opt(t.ValueDate), t.Kind, t.Status, cell(n.accounts[p.AccountID]),
			p.Amount.Amount(), p.Amount.Currency(), oa, oc, splitAmt, cell(category), cell(t.Description), cell(t.Payee),
			cell(merchant), cell(strings.Join(tags, ", ")), cell(t.Notes), t.Source, related, fmt.Sprint(t.ExcludeFromReports)})
	}
	if len(t.Splits) > 0 && len(t.Postings) == 1 {
		for _, s := range t.Splits {
			cat := ""
			if s.CategoryID != nil {
				cat = n.categories[*s.CategoryID]
			}
			row(t.Postings[0], s.Amount.Amount(), cat)
		}
		return
	}
	for _, p := range t.Postings {
		row(p, "", "")
	}
}
