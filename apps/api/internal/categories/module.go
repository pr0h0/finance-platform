// Package categories: Category hierarchy.
//
// Owned routes under /api/v1: /categories
// See docs/api/openapi.yaml for the contract.
package categories

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
)

type Category struct {
	ledger.Meta
	ParentID   *uuid.UUID `json:"parentId"`
	Name       string     `json:"name"`
	Kind       string     `json:"kind"`
	Color      string     `json:"color"`
	Icon       string     `json:"icon"`
	SortOrder  int        `json:"sortOrder"`
	IsSystem   bool       `json:"isSystem"`
	IsArchived bool       `json:"isArchived"`
}

// maxDepth bounds the hierarchy (category > subcategory > ...).
const maxDepth = 5

func write(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in, cur *Category) error {
	in.Name = strings.TrimSpace(in.Name)
	bad := map[string]string{}
	if in.Name == "" || len(in.Name) > 100 {
		bad["name"] = "required, at most 100 characters"
	}
	switch in.Kind {
	case "expense", "income", "transfer":
	default:
		bad["kind"] = "expense, income or transfer"
	}
	if len(in.Color) > 32 || len(in.Icon) > 64 {
		bad["color"] = "too long"
	}
	if len(bad) > 0 {
		return httpx.Validation(bad)
	}
	if cur != nil {
		in.IsSystem = cur.IsSystem
	} else {
		in.IsSystem = false
	}
	if in.ParentID != nil {
		// Walk up from the new parent: it must exist in the profile, must not be this category or one of
		// its descendants (cycle), and the resulting depth is bounded.
		depth, p := 1, in.ParentID
		for p != nil {
			if *p == id {
				return httpx.Validation(map[string]string{"parentId": "a category cannot be its own ancestor"})
			}
			var next *uuid.UUID
			err := tx.QueryRow(ctx, `SELECT parent_id FROM categories WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, *p, profileID).Scan(&next)
			if err == pgx.ErrNoRows {
				return httpx.Validation(map[string]string{"parentId": "unknown category"})
			}
			if err != nil {
				return err
			}
			if depth++; depth > maxDepth {
				return httpx.Validation(map[string]string{"parentId": "hierarchy too deep"})
			}
			p = next
		}
	}
	args := []any{id, profileID, in.ParentID, in.Name, in.Kind, in.Color, in.Icon, in.SortOrder, in.IsArchived, in.IsSystem}
	var err error
	if cur == nil {
		_, err = tx.Exec(ctx, `INSERT INTO categories (id, profile_id, parent_id, name, kind, color, icon, sort_order, is_archived, is_system)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, args...)
	} else {
		_, err = tx.Exec(ctx, `UPDATE categories SET parent_id=$3, name=$4, kind=$5, color=$6, icon=$7, sort_order=$8, is_archived=$9,
			version = version + 1 WHERE id=$1 AND profile_id=$2`, args[:9]...)
	}
	if ledger.IsUnique(err) {
		return httpx.Conflict("category id already exists")
	}
	return err
}

// Entity is the category CRUD definition (exported for the sync module's push handler).
var Entity = ledger.Entity[Category]{
	Table: "categories", Path: "/categories", Name: "category",
	Cols:    "parent_id, name, kind, color, icon, sort_order, is_system, is_archived",
	Order:   "kind, sort_order, lower(name), id",
	GetMeta: func(c *Category) *ledger.Meta { return &c.Meta },
	New:     func() *Category { return &Category{Kind: "expense"} },
	Scan: func(row pgx.Row) (*Category, error) {
		c := &Category{}
		return c, row.Scan(append(c.Dest(), &c.ParentID, &c.Name, &c.Kind, &c.Color, &c.Icon, &c.SortOrder, &c.IsSystem, &c.IsArchived)...)
	},
	Write: write,
	ListWhere: func(q url.Values) (string, []any) {
		if b, _ := strconv.ParseBool(q.Get("includeArchived")); b {
			return "", nil
		}
		return "NOT is_archived", nil
	},
	// Splits keep pointing at a deleted category (history stays intact); children must be moved first.
	BeforeDelete: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur *Category) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM categories WHERE parent_id = $1 AND deleted_at IS NULL`, cur.ID).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return httpx.Conflict("move or delete the subcategories first")
		}
		return nil
	},
}

// defaults is the starter set: parent -> children.
var defaults = []struct {
	kind, name string
	children   []string
}{
	{"expense", "Housing", []string{"Rent", "Utilities", "Maintenance"}},
	{"expense", "Food", []string{"Groceries", "Restaurants"}},
	{"expense", "Transport", []string{"Fuel", "Public transport", "Car"}},
	{"expense", "Health", nil},
	{"expense", "Shopping", []string{"Clothing", "Electronics"}},
	{"expense", "Entertainment", []string{"Subscriptions"}},
	{"expense", "Education", nil},
	{"expense", "Travel", nil},
	{"expense", "Fees & charges", []string{"Bank fees", "Currency conversion"}},
	{"expense", "Gifts & donations", nil},
	{"income", "Salary", nil},
	{"income", "Freelance", nil},
	{"income", "Bonus", nil},
	{"income", "Gifts received", nil},
	{"income", "Interest", nil},
	{"income", "Other income", nil},
}

// SeedDefaults creates the starter categories in a profile that has none (returns the number created).
func SeedDefaults(ctx context.Context, tx pgx.Tx, profileID uuid.UUID) (int, error) {
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM categories WHERE profile_id = $1 AND deleted_at IS NULL`, profileID).Scan(&n); err != nil || n > 0 {
		return 0, err
	}
	created := 0
	add := func(parent *uuid.UUID, kind, name string, order int) (uuid.UUID, error) {
		id := uuid.New()
		if _, err := tx.Exec(ctx, `INSERT INTO categories (id, profile_id, parent_id, name, kind, sort_order, is_system) VALUES ($1,$2,$3,$4,$5,$6,true)`,
			id, profileID, parent, name, kind, order); err != nil {
			return id, err
		}
		c, err := Entity.Get(ctx, tx, profileID, id, false)
		if err != nil {
			return id, err
		}
		_, err = changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "categories", EntityID: id, Op: changes.OpUpsert,
			Data: c, Action: "category.create", Metadata: map[string]any{"seed": true}})
		created++
		return id, err
	}
	for i, d := range defaults {
		pid, err := add(nil, d.kind, d.name, i*10)
		if err != nil {
			return created, err
		}
		for j, ch := range d.children {
			if _, err := add(&pid, d.kind, ch, j*10); err != nil {
				return created, err
			}
		}
	}
	return created, nil
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	Entity.Mount(r, deps.DB)
	r.With(httpx.Idempotent(deps.DB)).Post("/categories/defaults", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleEditor)
		if err != nil {
			return err
		}
		var n int
		if err := ledger.InTx(r.Context(), deps.DB, func(tx pgx.Tx) error {
			n, err = SeedDefaults(r.Context(), tx, profileID)
			return err
		}); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]int{"created": n})
		return nil
	}))
}
