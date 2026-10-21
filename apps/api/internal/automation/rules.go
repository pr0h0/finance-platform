package automation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/transactions"
)

// Condition of a categorization rule (domain RuleCondition). All conditions of a rule must match.
//   - description | payee | counterparty: op contains | equals | starts_with | regex (RE2, linear
//     time, <= 256 chars); case-insensitive unless caseSensitive.
//   - amount: op eq | lt | lte | gt | gte against the absolute transaction amount (decimal string).
//   - accountId | merchantId: op equals.
//   - direction: op equals debit | credit (sign of the first posting).
type Condition struct {
	Field         string `json:"field"`
	Op            string `json:"op"`
	Value         string `json:"value"`
	CaseSensitive bool   `json:"caseSensitive,omitempty"`
	re            *regexp.Regexp
}

// Action of a rule (domain RuleAction).
type Action struct {
	Type            string     `json:"type"` // set_category | set_merchant | add_tag | set_description | apply_split_template | exclude_from_reports
	CategoryID      *uuid.UUID `json:"categoryId,omitempty"`
	MerchantID      *uuid.UUID `json:"merchantId,omitempty"`
	TagID           *uuid.UUID `json:"tagId,omitempty"`
	SplitTemplateID *uuid.UUID `json:"splitTemplateId,omitempty"`
	Value           string     `json:"value,omitempty"`
}

// Rule is the API shape (OpenAPI Rule).
type Rule struct {
	ID             uuid.UUID   `json:"id"`
	ProfileID      uuid.UUID   `json:"profileId"`
	Version        int         `json:"version"`
	ServerVersion  int64       `json:"serverVersion"`
	CreatedAt      time.Time   `json:"createdAt"`
	UpdatedAt      time.Time   `json:"updatedAt"`
	DeletedAt      *time.Time  `json:"deletedAt"`
	Name           string      `json:"name"`
	Priority       int         `json:"priority"`
	Conditions     []Condition `json:"conditions"`
	Actions        []Action    `json:"actions"`
	Enabled        bool        `json:"enabled"`
	StopProcessing bool        `json:"stopProcessing"`
	MatchCount     int64       `json:"matchCount"`
	LastMatchedAt  *time.Time  `json:"lastMatchedAt"`
}

type RuleInput struct {
	ID             *uuid.UUID  `json:"id,omitempty"`
	Name           string      `json:"name"`
	Priority       *int        `json:"priority"`
	Conditions     []Condition `json:"conditions"`
	Actions        []Action    `json:"actions"`
	Enabled        *bool       `json:"enabled"`
	StopProcessing bool        `json:"stopProcessing"`
	Version        *int        `json:"version,omitempty"`
}

func (in *RuleInput) validate(ctx context.Context, db fin.DB, profileID uuid.UUID) error {
	v := fin.Validator{}
	in.Name = strings.TrimSpace(in.Name)
	v.Check(in.Name != "" && len(in.Name) <= 200, "name", "required, at most 200 characters")
	if in.Priority == nil {
		p := 100
		in.Priority = &p
	}
	v.Check(*in.Priority >= 0 && *in.Priority <= 1_000_000, "priority", "must be 0..1000000 (lower runs first)")
	if in.Enabled == nil {
		t := true
		in.Enabled = &t
	}
	v.Check(len(in.Conditions) >= 1 && len(in.Conditions) <= 20, "conditions", "1..20 conditions")
	v.Check(len(in.Actions) >= 1 && len(in.Actions) <= 10, "actions", "1..10 actions")
	for i := range in.Conditions {
		c := &in.Conditions[i]
		f := fmt.Sprintf("conditions[%d]", i)
		switch c.Field {
		case "description", "payee", "counterparty":
			v.Check(fin.OneOf(c.Op, "contains", "equals", "starts_with", "regex"), f+".op", "contains, equals, starts_with or regex")
			v.Check(c.Value != "" && len(c.Value) <= 256, f+".value", "1..256 characters")
			if c.Op == "regex" {
				_, err := compile(*c)
				v.Check(err == nil, f+".value", "invalid regular expression (RE2 syntax)")
			}
		case "amount":
			v.Check(fin.OneOf(c.Op, "eq", "lt", "lte", "gt", "gte"), f+".op", "eq, lt, lte, gt or gte")
			r, ok := new(big.Rat).SetString(c.Value)
			v.Check(ok && r.Sign() >= 0 && !strings.ContainsAny(c.Value, "eE/"), f+".value", "non-negative decimal string")
		case "accountId", "merchantId":
			v.Check(c.Op == "equals", f+".op", "equals")
			id, err := uuid.Parse(c.Value)
			v.Check(err == nil, f+".value", "uuid")
			if err == nil {
				table := map[string]string{"accountId": "accounts", "merchantId": "merchants"}[c.Field]
				if err := fin.CheckOwned(ctx, db, v, f+".value", table, &id, profileID); err != nil {
					return err
				}
			}
		case "direction":
			v.Check(c.Op == "equals" && fin.OneOf(c.Value, "debit", "credit"), f+".value", "equals debit or credit")
		default:
			v[f+".field"] = "description, payee, counterparty, amount, accountId, merchantId or direction"
		}
	}
	for i, a := range in.Actions {
		f := fmt.Sprintf("actions[%d]", i)
		var ref *uuid.UUID
		table := ""
		switch a.Type {
		case "set_category":
			ref, table = a.CategoryID, "categories"
			v.Check(a.CategoryID != nil, f+".categoryId", "required")
		case "set_merchant":
			ref, table = a.MerchantID, "merchants"
			v.Check(a.MerchantID != nil, f+".merchantId", "required")
		case "add_tag":
			ref, table = a.TagID, "tags"
			v.Check(a.TagID != nil, f+".tagId", "required")
		case "apply_split_template":
			ref, table = a.SplitTemplateID, "split_templates"
			v.Check(a.SplitTemplateID != nil, f+".splitTemplateId", "required")
		case "set_description":
			v.Check(a.Value != "" && len(a.Value) <= 500, f+".value", "1..500 characters")
		case "exclude_from_reports":
		default:
			v[f+".type"] = "set_category, set_merchant, add_tag, set_description, apply_split_template or exclude_from_reports"
		}
		if table != "" {
			if err := fin.CheckOwned(ctx, db, v, f, table, ref, profileID); err != nil {
				return err
			}
		}
	}
	return v.Err()
}

func compile(c Condition) (*regexp.Regexp, error) {
	p := c.Value
	if !c.CaseSensitive {
		p = "(?i)" + p
	}
	return regexp.Compile(p)
}

const ruleCols = `id, profile_id, version, server_version, created_at, updated_at, deleted_at, name, priority, conditions, actions,
	enabled, stop_processing, match_count, last_matched_at`

func scanRule(row pgx.Row) (Rule, error) {
	var r Rule
	var conds, acts []byte
	err := row.Scan(&r.ID, &r.ProfileID, &r.Version, &r.ServerVersion, &r.CreatedAt, &r.UpdatedAt, &r.DeletedAt, &r.Name, &r.Priority,
		&conds, &acts, &r.Enabled, &r.StopProcessing, &r.MatchCount, &r.LastMatchedAt)
	if err == nil {
		err = json.Unmarshal(conds, &r.Conditions)
	}
	if err == nil {
		err = json.Unmarshal(acts, &r.Actions)
	}
	for i := range r.Conditions {
		if r.Conditions[i].Op == "regex" {
			r.Conditions[i].re, _ = compile(r.Conditions[i])
		}
	}
	return r, err
}

func GetRule(ctx context.Context, db fin.DB, profileID, id uuid.UUID) (Rule, error) {
	r, err := scanRule(db.QueryRow(ctx, `SELECT `+ruleCols+` FROM categorization_rules WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return r, httpx.NotFound("rule")
	}
	return r, err
}

// ListRules returns rules in evaluation order (priority ascending, then id) after the cursor.
func ListRules(ctx context.Context, db fin.DB, profileID uuid.UUID, enabledOnly bool) ([]Rule, error) {
	rows, err := db.Query(ctx, `SELECT `+ruleCols+` FROM categorization_rules WHERE profile_id = $1 AND deleted_at IS NULL
		AND (enabled OR NOT $2) ORDER BY priority, created_at, id`, profileID, enabledOnly)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Rule, error) { return scanRule(row) })
}

func CreateRule(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, in RuleInput) (Rule, error) {
	if err := in.validate(ctx, tx, profileID); err != nil {
		return Rule{}, err
	}
	id := uuid.New()
	if in.ID != nil {
		id = *in.ID
	}
	conds, _ := json.Marshal(in.Conditions)
	acts, _ := json.Marshal(in.Actions)
	if _, err := tx.Exec(ctx, `INSERT INTO categorization_rules (id, profile_id, name, priority, conditions, actions, enabled, stop_processing)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, id, profileID, in.Name, *in.Priority, conds, acts, *in.Enabled, in.StopProcessing); err != nil {
		if ledger.IsUnique(err) {
			return Rule{}, httpx.Conflict("rule id already exists")
		}
		return Rule{}, err
	}
	return recordRule(ctx, tx, profileID, id, nil, "rule.create")
}

func UpdateRule(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Rule, in RuleInput) (Rule, error) {
	if err := fin.CheckVersion(in.Version, cur.Version); err != nil {
		return cur, err
	}
	if err := in.validate(ctx, tx, profileID); err != nil {
		return cur, err
	}
	conds, _ := json.Marshal(in.Conditions)
	acts, _ := json.Marshal(in.Actions)
	if _, err := tx.Exec(ctx, `UPDATE categorization_rules SET name=$3, priority=$4, conditions=$5, actions=$6, enabled=$7, stop_processing=$8,
		version = version + 1 WHERE id = $1 AND profile_id = $2`, cur.ID, profileID, in.Name, *in.Priority, conds, acts, *in.Enabled, in.StopProcessing); err != nil {
		return cur, err
	}
	return recordRule(ctx, tx, profileID, cur.ID, cur, "rule.update")
}

func DeleteRule(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Rule) error {
	if _, err := tx.Exec(ctx, `UPDATE categorization_rules SET deleted_at = now(), version = version + 1 WHERE id = $1 AND profile_id = $2`, cur.ID, profileID); err != nil {
		return err
	}
	_, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "categorization_rules", EntityID: cur.ID, Op: changes.OpDelete, Before: cur, Action: "rule.delete"})
	return err
}

func recordRule(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, before any, action string) (Rule, error) {
	r, err := GetRule(ctx, tx, profileID, id)
	if err != nil {
		return r, err
	}
	v, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "categorization_rules", EntityID: id, Op: changes.OpUpsert, Data: r, Before: before, Action: action})
	r.ServerVersion = v
	return r, err
}

// ===== evaluation =====

// Facts are the transaction attributes rules look at.
type Facts struct {
	Txn          *ledger.Transaction
	Counterparty string // from the imported source record, if any
}

func (f Facts) amount() *big.Rat {
	if len(f.Txn.Postings) == 0 {
		return new(big.Rat)
	}
	r, _ := new(big.Rat).SetString(f.Txn.Postings[0].Amount.Abs().Amount())
	return r
}

// Matches reports whether every condition of the rule holds.
func (r Rule) Matches(f Facts) bool {
	for _, c := range r.Conditions {
		if !c.matches(f) {
			return false
		}
	}
	return len(r.Conditions) > 0
}

func (c Condition) matches(f Facts) bool {
	t := f.Txn
	switch c.Field {
	case "description", "payee", "counterparty":
		s := map[string]string{"description": t.Description, "payee": t.Payee, "counterparty": f.Counterparty}[c.Field]
		if c.Op == "regex" {
			re := c.re
			if re == nil {
				var err error
				if re, err = compile(c); err != nil {
					return false
				}
			}
			return re.MatchString(s)
		}
		v := c.Value
		if !c.CaseSensitive {
			s, v = strings.ToLower(s), strings.ToLower(v)
		}
		switch c.Op {
		case "contains":
			return strings.Contains(s, v)
		case "equals":
			return strings.TrimSpace(s) == strings.TrimSpace(v)
		case "starts_with":
			return strings.HasPrefix(strings.TrimSpace(s), v)
		}
	case "amount":
		want, ok := new(big.Rat).SetString(c.Value)
		if !ok {
			return false
		}
		cmp := f.amount().Cmp(want)
		switch c.Op {
		case "eq":
			return cmp == 0
		case "lt":
			return cmp < 0
		case "lte":
			return cmp <= 0
		case "gt":
			return cmp > 0
		case "gte":
			return cmp >= 0
		}
	case "accountId":
		for _, p := range t.Postings {
			if p.AccountID.String() == c.Value {
				return true
			}
		}
	case "merchantId":
		return t.MerchantID != nil && t.MerchantID.String() == c.Value
	case "direction":
		if len(t.Postings) == 0 {
			return false
		}
		d := "credit"
		if t.Postings[0].Amount.Sign() < 0 {
			d = "debit"
		}
		return d == c.Value
	}
	return false
}

// apply runs the rule's actions on `after` (a clone of the current state). Returns what changed
// or why an action was skipped.
func (r Rule) apply(ctx context.Context, db fin.DB, after *ledger.Transaction) (changed bool, skipped []string, err error) {
	for _, a := range r.Actions {
		switch a.Type {
		case "set_category":
			switch {
			case !ledger.SplitKinds(after.Kind):
				skipped = append(skipped, after.Kind+" transactions are not categorized")
			case len(after.Splits) != 1:
				skipped = append(skipped, "transaction has several splits; use apply_split_template")
			case after.Splits[0].CategoryID == nil || *after.Splits[0].CategoryID != *a.CategoryID:
				after.Splits[0].CategoryID = a.CategoryID
				after.CategorizationSource, changed = "rule", true
			}
		case "set_merchant":
			if after.MerchantID == nil || *after.MerchantID != *a.MerchantID {
				after.MerchantID, changed = a.MerchantID, true
			}
		case "add_tag":
			has := false
			for _, t := range after.TagIDs {
				has = has || t == *a.TagID
			}
			if !has {
				after.TagIDs, changed = append(after.TagIDs, *a.TagID), true
			}
		case "set_description":
			if after.Description != a.Value {
				after.Description, changed = a.Value, true
			}
		case "exclude_from_reports":
			if !after.ExcludeFromReports {
				after.ExcludeFromReports, changed = true, true
			}
		case "apply_split_template":
			if !ledger.SplitKinds(after.Kind) || len(after.Postings) != 1 {
				skipped = append(skipped, "split templates apply to single-posting income/expense/refund transactions")
				continue
			}
			var lines []byte
			if err := db.QueryRow(ctx, `SELECT lines FROM split_templates WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, *a.SplitTemplateID, after.ProfileID).Scan(&lines); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					skipped = append(skipped, "split template was deleted")
					continue
				}
				return false, nil, err
			}
			var tpl transactions.SplitTemplate
			if err := json.Unmarshal(lines, &tpl.Lines); err != nil {
				return false, nil, err
			}
			splits, err := transactions.ApplySplitTemplate(&tpl, after.Postings[0].Amount)
			if err != nil {
				skipped = append(skipped, err.Error())
				continue
			}
			after.Splits, after.CategorizationSource, changed = splits, "rule", true
		}
	}
	return changed, skipped, nil
}

// Overwritable reports whether automatic categorization may change a transaction: never once the
// user (or an approved MCP change) categorized it.
func Overwritable(t *ledger.Transaction) bool {
	return fin.OneOf(t.CategorizationSource, "none", "import", "suggestion", "rule")
}

func counterparty(ctx context.Context, db fin.DB, t *ledger.Transaction) (string, error) {
	if t.ImportRecordID == nil {
		return "", nil
	}
	var cp string
	err := db.QueryRow(ctx, `SELECT counterparty FROM imported_raw_records WHERE id = $1 AND profile_id = $2`, *t.ImportRecordID, t.ProfileID).Scan(&cp)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return cp, err
}

// ApplyRules evaluates the profile's enabled rules (priority order, stopProcessing honoured) on
// the given transactions inside tx and saves the result through ledger.Update (audited, synced).
// Transactions categorized by the user are left alone. Imports and transaction creation call this
// for new transactions. Returns the ids that changed.
func ApplyRules(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, ids []uuid.UUID) ([]uuid.UUID, error) {
	rules, err := ListRules(ctx, tx, profileID, true)
	if err != nil || len(rules) == 0 {
		return nil, err
	}
	var out []uuid.UUID
	for _, id := range ids {
		cur, err := ledger.Get(ctx, tx, profileID, id, true)
		if err != nil {
			return out, err
		}
		if cur.DeletedAt != nil || !Overwritable(cur) {
			continue
		}
		cp, err := counterparty(ctx, tx, cur)
		if err != nil {
			return out, err
		}
		after := cur.Clone()
		changed := false
		var hit []uuid.UUID
		for _, r := range rules {
			if !r.Matches(Facts{Txn: cur, Counterparty: cp}) {
				continue
			}
			c, _, err := r.apply(ctx, tx, after)
			if err != nil {
				return out, err
			}
			changed = changed || c
			hit = append(hit, r.ID)
			if r.StopProcessing {
				break
			}
		}
		if !changed {
			continue
		}
		if _, err := ledger.Update(ctx, tx, cur, after, "rule.auto_apply", map[string]any{"rule_ids": hit}); err != nil {
			return out, err
		}
		if err := bumpMatches(ctx, tx, hit, 1); err != nil {
			return out, err
		}
		out = append(out, id)
	}
	return out, nil
}

func bumpMatches(ctx context.Context, tx pgx.Tx, ruleIDs []uuid.UUID, n int) error {
	_, err := tx.Exec(ctx, `UPDATE categorization_rules SET match_count = match_count + $2, last_matched_at = now() WHERE id = ANY($1)`, ruleIDs, n)
	return err
}

// ApplyResult is OpenAPI BulkResult plus the application id used for undo and the matched ids.
type ApplyResult struct {
	ApplicationID *uuid.UUID                 `json:"applicationId"`
	DryRun        bool                       `json:"dryRun"`
	Matched       []uuid.UUID                `json:"matched"`
	Updated       int                        `json:"updated"`
	Failed        []transactions.BulkFailure `json:"failed"`
}

// ApplyRule runs one rule over existing transactions booked in [from, to] (at most 5000, newest
// first). dryRun only reports matches. overwrite=false skips user-categorized transactions.
func ApplyRule(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, r Rule, from, to time.Time, dryRun, overwrite bool) (ApplyResult, error) {
	res := ApplyResult{DryRun: dryRun, Matched: []uuid.UUID{}, Failed: []transactions.BulkFailure{}}
	txs, err := ledger.Query(ctx, tx, `SELECT `+ledger.TxCols+` FROM transactions t WHERE t.profile_id = $1 AND t.deleted_at IS NULL
		AND t.booking_date BETWEEN $2 AND $3 ORDER BY t.booking_date DESC, t.id LIMIT 5000`, profileID, from, to)
	if err != nil {
		return res, err
	}
	appID := uuid.New()
	for _, t := range txs {
		if !overwrite && !Overwritable(t) {
			continue
		}
		cp, err := counterparty(ctx, tx, t)
		if err != nil {
			return res, err
		}
		if !r.Matches(Facts{Txn: t, Counterparty: cp}) {
			continue
		}
		res.Matched = append(res.Matched, t.ID)
		if dryRun {
			continue
		}
		cur, err := ledger.Get(ctx, tx, profileID, t.ID, true)
		if err != nil {
			return res, err
		}
		after := cur.Clone()
		changed, skipped, err := r.apply(ctx, tx, after)
		if err != nil {
			return res, err
		}
		if len(skipped) > 0 && !changed {
			res.Failed = append(res.Failed, transactions.BulkFailure{ID: t.ID, Code: "skipped", Message: strings.Join(skipped, "; ")})
			continue
		}
		if !changed {
			continue
		}
		if _, err := ledger.Update(ctx, tx, cur, after, "rule.apply", map[string]any{"rule_id": r.ID.String(), "rule_application_id": appID.String()}); err != nil {
			var he *httpx.Error
			if errors.As(err, &he) {
				res.Failed = append(res.Failed, transactions.BulkFailure{ID: t.ID, Code: he.Code, Message: he.Message})
				continue
			}
			return res, err
		}
		res.Updated++
	}
	if res.Updated > 0 {
		res.ApplicationID = &appID
		if err := bumpMatches(ctx, tx, []uuid.UUID{r.ID}, res.Updated); err != nil {
			return res, err
		}
		if _, err := recordRule(ctx, tx, profileID, r.ID, nil, "rule.stats"); err != nil {
			return res, err
		}
	}
	return res, nil
}

// UndoApplication reverts the metadata a rule application changed (Feature 84), using the
// before-snapshots in the audit log. A transaction edited since the application is not touched
// and is reported as failed ("modified").
func UndoApplication(ctx context.Context, tx pgx.Tx, profileID, appID uuid.UUID) (transactions.BulkResult, error) {
	res := transactions.BulkResult{Failed: []transactions.BulkFailure{}}
	rows, err := tx.Query(ctx, `SELECT entity_id, before, after FROM audit_log
		WHERE profile_id = $1 AND metadata->>'rule_application_id' = $2 AND action = 'rule.apply' AND entity_type = 'transactions'
		ORDER BY id`, profileID, appID.String())
	if err != nil {
		return res, err
	}
	type entry struct {
		id            uuid.UUID
		before, after ledger.Transaction
	}
	var entries []entry
	for rows.Next() {
		var e entry
		var b, a []byte
		if err := rows.Scan(&e.id, &b, &a); err != nil {
			rows.Close()
			return res, err
		}
		if json.Unmarshal(b, &e.before) != nil || json.Unmarshal(a, &e.after) != nil {
			rows.Close()
			return res, fmt.Errorf("undo: unreadable audit snapshot for %s", e.id)
		}
		entries = append(entries, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}
	if len(entries) == 0 {
		return res, httpx.NotFound("rule application")
	}
	for _, e := range entries {
		cur, err := ledger.Get(ctx, tx, profileID, e.id, true)
		if err != nil {
			return res, err
		}
		if cur.Version != e.after.Version || cur.DeletedAt != nil {
			res.Failed = append(res.Failed, transactions.BulkFailure{ID: e.id, Code: "modified", Message: "transaction changed after the rule ran; not reverted"})
			continue
		}
		after := cur.Clone()
		after.Splits, after.MerchantID, after.TagIDs = e.before.Splits, e.before.MerchantID, e.before.TagIDs
		after.Description, after.ExcludeFromReports, after.CategorizationSource = e.before.Description, e.before.ExcludeFromReports, e.before.CategorizationSource
		if after.TagIDs == nil {
			after.TagIDs = []uuid.UUID{}
		}
		if _, err := ledger.Update(ctx, tx, cur, after, "rule.undo", map[string]any{"undo_of": appID.String()}); err != nil {
			return res, err
		}
		res.Updated++
	}
	return res, nil
}
