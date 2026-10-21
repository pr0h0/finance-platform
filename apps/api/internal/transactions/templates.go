package transactions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// ---- tags ----

type Tag struct {
	ledger.Meta
	Name  string `json:"name"`
	Color string `json:"color"`
}

var tags = ledger.Entity[Tag]{Table: "tags", Path: "/tags", Name: "tag", Cols: "name, color", Order: "lower(name), id",
	GetMeta: func(t *Tag) *ledger.Meta { return &t.Meta },
	Scan: func(row pgx.Row) (*Tag, error) {
		t := &Tag{}
		return t, row.Scan(append(t.Dest(), &t.Name, &t.Color)...)
	},
	Write: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in, cur *Tag) error {
		in.Name = strings.TrimSpace(in.Name)
		if in.Name == "" || len(in.Name) > 100 || len(in.Color) > 32 {
			return httpx.Validation(map[string]string{"name": "required, at most 100 characters"})
		}
		var err error
		if cur == nil {
			_, err = tx.Exec(ctx, `INSERT INTO tags (id, profile_id, name, color) VALUES ($1,$2,$3,$4)`, id, profileID, in.Name, in.Color)
		} else {
			_, err = tx.Exec(ctx, `UPDATE tags SET name=$2, color=$3, version = version + 1 WHERE id = $1`, id, in.Name, in.Color)
		}
		if ledger.IsUnique(err) {
			return httpx.Conflict("a tag with this name exists")
		}
		return err
	},
}

// ---- transaction templates (feature 12) ----

type TransactionTemplate struct {
	ledger.Meta
	Name        string       `json:"name"`
	Kind        string       `json:"kind"`
	AccountID   *uuid.UUID   `json:"accountId"`
	ToAccountID *uuid.UUID   `json:"toAccountId"`
	Amount      *money.Money `json:"amount"`
	CategoryID  *uuid.UUID   `json:"categoryId"`
	MerchantID  *uuid.UUID   `json:"merchantId"`
	Description string       `json:"description"`
	TagIDs      []uuid.UUID  `json:"tagIds"`
	SortOrder   int          `json:"sortOrder"`
}

func ownedRefs(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, refs map[string]struct {
	table string
	ids   []uuid.UUID
}) error {
	for field, ref := range refs {
		var ids []uuid.UUID
		for _, id := range ref.ids {
			if id != uuid.Nil {
				ids = append(ids, id)
			}
		}
		if ok, err := ledger.Owned(ctx, tx, ref.table, profileID, ids); err != nil || !ok {
			return firstErr(err, httpx.Validation(map[string]string{field: "unknown " + strings.TrimSuffix(ref.table, "s")}))
		}
	}
	return nil
}

func deref(p *uuid.UUID) uuid.UUID {
	if p == nil {
		return uuid.Nil
	}
	return *p
}

var templates = ledger.Entity[TransactionTemplate]{Table: "transaction_templates", Path: "/transaction-templates", Name: "transaction_template",
	Cols:    "name, kind, account_id, to_account_id, amount, currency, category_id, merchant_id, description, tag_ids, sort_order",
	Order:   "sort_order, lower(name), id",
	GetMeta: func(t *TransactionTemplate) *ledger.Meta { return &t.Meta },
	Scan: func(row pgx.Row) (*TransactionTemplate, error) {
		t := &TransactionTemplate{}
		var amt pgtype.Numeric
		var cur *string
		err := row.Scan(append(t.Dest(), &t.Name, &t.Kind, &t.AccountID, &t.ToAccountID, &amt, &cur, &t.CategoryID, &t.MerchantID,
			&t.Description, &t.TagIDs, &t.SortOrder)...)
		if err == nil && amt.Valid && cur != nil {
			m, merr := money.FromNumeric(amt, *cur)
			t.Amount, err = &m, merr
		}
		return t, err
	},
	Write: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in, cur *TransactionTemplate) error {
		in.Name = strings.TrimSpace(in.Name)
		bad := map[string]string{}
		if in.Name == "" || len(in.Name) > 200 {
			bad["name"] = "required, at most 200 characters"
		}
		if in.Kind != "income" && in.Kind != "expense" && in.Kind != "transfer" {
			bad["kind"] = "income, expense or transfer"
		}
		if in.Amount != nil && in.Amount.Sign() <= 0 {
			bad["amount"] = "must be positive"
		}
		if len(in.Description) > 500 || len(in.TagIDs) > 50 {
			bad["description"] = "too long"
		}
		if len(bad) > 0 {
			return httpx.Validation(bad)
		}
		if in.TagIDs == nil {
			in.TagIDs = []uuid.UUID{}
		}
		if err := ownedRefs(ctx, tx, profileID, map[string]struct {
			table string
			ids   []uuid.UUID
		}{
			"accountId": {"accounts", []uuid.UUID{deref(in.AccountID), deref(in.ToAccountID)}}, "categoryId": {"categories", []uuid.UUID{deref(in.CategoryID)}},
			"merchantId": {"merchants", []uuid.UUID{deref(in.MerchantID)}}, "tagIds": {"tags", in.TagIDs},
		}); err != nil {
			return err
		}
		var amt pgtype.Numeric
		var c *string
		if in.Amount != nil {
			amt = in.Amount.Numeric()
			cc := in.Amount.Currency()
			c = &cc
		}
		args := []any{id, profileID, in.Name, in.Kind, in.AccountID, in.ToAccountID, amt, c, in.CategoryID, in.MerchantID, in.Description, in.TagIDs, in.SortOrder}
		var err error
		if cur == nil {
			_, err = tx.Exec(ctx, `INSERT INTO transaction_templates (id, profile_id, name, kind, account_id, to_account_id, amount, currency,
				category_id, merchant_id, description, tag_ids, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, args...)
		} else {
			_, err = tx.Exec(ctx, `UPDATE transaction_templates SET name=$3, kind=$4, account_id=$5, to_account_id=$6, amount=$7, currency=$8,
				category_id=$9, merchant_id=$10, description=$11, tag_ids=$12, sort_order=$13, version = version + 1
				WHERE id=$1 AND profile_id=$2`, args...)
		}
		if ledger.IsUnique(err) {
			return httpx.Conflict("id already exists")
		}
		return err
	},
}

// ---- split templates ----

// SplitTemplateLine allocates either a fixed amount or a share (weight) of the remainder.
type SplitTemplateLine struct {
	CategoryID  *uuid.UUID   `json:"categoryId"`
	Weight      *string      `json:"weight,omitempty"`
	Amount      *money.Money `json:"amount,omitempty"`
	Description string       `json:"description"`
}

type SplitTemplate struct {
	ledger.Meta
	Name       string              `json:"name"`
	MerchantID *uuid.UUID          `json:"merchantId"`
	Lines      []SplitTemplateLine `json:"lines"`
}

var splitTemplates = ledger.Entity[SplitTemplate]{Table: "split_templates", Path: "/split-templates", Name: "split_template",
	Cols: "name, merchant_id, lines", Order: "lower(name), id",
	GetMeta: func(t *SplitTemplate) *ledger.Meta { return &t.Meta },
	Scan: func(row pgx.Row) (*SplitTemplate, error) {
		t := &SplitTemplate{}
		var lines []byte
		err := row.Scan(append(t.Dest(), &t.Name, &t.MerchantID, &lines)...)
		if err == nil {
			err = json.Unmarshal(lines, &t.Lines)
		}
		return t, err
	},
	Write: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in, cur *SplitTemplate) error {
		in.Name = strings.TrimSpace(in.Name)
		if in.Name == "" || len(in.Name) > 200 || len(in.Lines) == 0 || len(in.Lines) > 100 {
			return httpx.Validation(map[string]string{"lines": "name and 1..100 lines required"})
		}
		var cats []uuid.UUID
		for i, l := range in.Lines {
			if (l.Weight == nil) == (l.Amount == nil) {
				return httpx.Validation(map[string]string{fmt.Sprintf("lines[%d]", i): "set exactly one of weight or amount"})
			}
			if l.Weight != nil && (!decimalRE(*l.Weight) || strings.HasPrefix(*l.Weight, "-")) {
				return httpx.Validation(map[string]string{fmt.Sprintf("lines[%d].weight", i): "non-negative decimal string"})
			}
			if l.Amount != nil && l.Amount.Sign() <= 0 {
				return httpx.Validation(map[string]string{fmt.Sprintf("lines[%d].amount", i): "must be positive"})
			}
			cats = append(cats, deref(l.CategoryID))
		}
		if err := ownedRefs(ctx, tx, profileID, map[string]struct {
			table string
			ids   []uuid.UUID
		}{"lines": {"categories", cats}, "merchantId": {"merchants", []uuid.UUID{deref(in.MerchantID)}}}); err != nil {
			return err
		}
		lines, _ := json.Marshal(in.Lines)
		var err error
		if cur == nil {
			_, err = tx.Exec(ctx, `INSERT INTO split_templates (id, profile_id, name, merchant_id, lines) VALUES ($1,$2,$3,$4,$5)`,
				id, profileID, in.Name, in.MerchantID, lines)
		} else {
			_, err = tx.Exec(ctx, `UPDATE split_templates SET name=$2, merchant_id=$3, lines=$4, version = version + 1 WHERE id = $1`,
				id, in.Name, in.MerchantID, lines)
		}
		if ledger.IsUnique(err) {
			return httpx.Conflict("id already exists")
		}
		return err
	},
}

// ApplySplitTemplate allocates total over the template: fixed-amount lines first, the remainder by weight
// (largest remainder, exact). Without weight lines the fixed amounts must sum exactly to total.
func ApplySplitTemplate(t *SplitTemplate, total money.Money) ([]ledger.Split, error) {
	rest := total.Abs()
	var weights []string
	var weighted []int
	out := make([]ledger.Split, len(t.Lines))
	for i, l := range t.Lines {
		out[i] = ledger.Split{CategoryID: l.CategoryID, Description: l.Description}
		if l.Amount != nil {
			var err error
			if rest, err = rest.Sub(*l.Amount); err != nil {
				return nil, httpx.Validation(map[string]string{"splitTemplateId": "template amounts are in another currency"})
			}
			out[i].Amount = *l.Amount
			continue
		}
		weights, weighted = append(weights, *l.Weight), append(weighted, i)
	}
	if rest.Sign() < 0 || (len(weights) == 0 && !rest.IsZero()) {
		return nil, httpx.Unprocessable("split template amounts do not fit the transaction amount")
	}
	if len(weights) > 0 {
		parts, err := rest.Allocate(weights)
		if err != nil {
			return nil, httpx.Validation(map[string]string{"splitTemplateId": err.Error()})
		}
		for k, i := range weighted {
			out[i].Amount = parts[k]
		}
	}
	var nonZero []ledger.Split
	for _, s := range out {
		if s.Amount.Sign() > 0 {
			nonZero = append(nonZero, s)
		}
	}
	return nonZero, nil
}
